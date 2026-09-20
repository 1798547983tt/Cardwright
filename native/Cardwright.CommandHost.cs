// Cardwright's command broker. Only this process grants the unique child SID access.
// No network capability is granted. AppContainer is a file/process/network boundary;
// ordinary AppContainer still has access to Windows' shared application resources.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class CommandHost {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4000000 };
    static readonly object OutputLock = new object();
    static readonly object InputLock = new object();
    static readonly List<string> GrantedPaths = new List<string>();
    static readonly Dictionary<string, int> GrantMasks = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
    static SecurityIdentifier Sid;
    static string ProfileName;
    static string ScriptPath;
    static IntPtr ProfileSid, Job, Process, ConsoleHandle, ChildInput;
    static volatile bool Closing;
    static bool TimedOut;
    const int HANDLE_FLAG_INHERIT = 1;
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint CREATE_SUSPENDED = 4, CREATE_UNICODE_ENVIRONMENT = 0x400, EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_NO_WINDOW = 0x08000000;

    static void Emit(object value) { lock (OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    static string Text(IDictionary<string, object> value, string key, string fallback) { object found; return value.TryGetValue(key, out found) && found is string ? (string)found : fallback; }
    static bool Flag(IDictionary<string, object> value, string key) { object found; return value.TryGetValue(key, out found) && found is bool && (bool)found; }
    static int Number(IDictionary<string, object> value, string key, int fallback) { object found; return value.TryGetValue(key, out found) ? Convert.ToInt32(found) : fallback; }
    static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static void HResult(int result, string operation) { if (result < 0) throw new Exception(operation + ": 0x" + result.ToString("X8")); }
    static IntPtr Alloc(object value) { IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(value)); Marshal.StructureToPtr(value, ptr, false); return ptr; }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }

    static string ValidateRoot(string path, bool directoryOnly = true) {
        string root = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
        if (!Path.IsPathRooted(path) || root.Length < 4 || root.StartsWith(@"\\") || root.IndexOf(':', 2) >= 0) throw new Exception("A normal, local, absolute directory is required.");
        if (!Directory.Exists(root) && (directoryOnly || !File.Exists(root))) throw new Exception("Permission path does not exist: " + root);
        string current = root;
        while (current != null) {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new Exception("Permission roots may not traverse a reparse point: " + current);
            current = Path.GetDirectoryName(current);
        }
        return root;
    }

    static byte[] PermissionDescriptor(string path, int mask, AceFlags flags) {
        byte[] original = Directory.Exists(path) ? Directory.GetAccessControl(path, AccessControlSections.Access).GetSecurityDescriptorBinaryForm() : File.GetAccessControl(path, AccessControlSections.Access).GetSecurityDescriptorBinaryForm();
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(original, 0);
        RawAcl acl = descriptor.DiscretionaryAcl;
        if (acl == null) throw new Exception("Permission root has an unrestricted DACL: " + path);
        for (int index = acl.Count - 1; index >= 0; index--) { KnownAce ace = acl[index] as KnownAce; if (ace != null && ace.SecurityIdentifier == Sid) acl.RemoveAce(index); }
        if (mask != 0) {
            int index = 0; while (index < acl.Count && (acl[index].AceFlags & AceFlags.Inherited) == 0) index++;
            acl.InsertAce(index, new CommonAce(flags, AceQualifier.AccessAllowed, mask, Sid, false, null));
        }
        byte[] bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0); return bytes;
    }

    static void CheckHardLinks(string root) {
        Stack<string> pending = new Stack<string>(); pending.Push(root);
        int files = 0;
        while (pending.Count != 0) {
            string path = pending.Pop(); FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
            if ((attributes & FileAttributes.Directory) != 0) { foreach (string entry in Directory.EnumerateFileSystemEntries(path)) pending.Push(entry); continue; }
            if (++files > 250000) throw new Exception("Permission root exceeds the 250000-file isolation validation limit. Choose a smaller root or explicitly approved host execution.");
            using (SafeFileHandle file = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
                if (file.IsInvalid) Check(false, "Inspect file links: " + path);
                BY_HANDLE_FILE_INFORMATION information; Check(GetFileInformationByHandle(file, out information), "Inspect file links: " + path);
                if (information.NumberOfLinks > 1) throw new Exception("Hard-linked files cannot be isolated safely: " + path + ". Use a copy-based workspace or explicitly approved host execution.");
            }
        }
    }

    static void ChangePermission(string path, int mask) {
        string key; using (SHA256 hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(path.ToUpperInvariant()))).Replace("-", "");
        // Read-modify-write must be serialized across parallel task containers.
        using (Mutex mutex = new Mutex(false, @"Local\Cardwright.CommandAcl." + key)) {
            bool acquired = false;
            try {
                try { acquired = mutex.WaitOne(30000); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new Exception("Another command is preparing this permission root.");
                if (Directory.Exists(path)) {
                    DirectorySecurity security = new DirectorySecurity(); security.SetSecurityDescriptorBinaryForm(PermissionDescriptor(path, mask, AceFlags.ContainerInherit | AceFlags.ObjectInherit), AccessControlSections.Access);
                    Directory.SetAccessControl(path, security);
                } else {
                    FileSecurity security = new FileSecurity(); security.SetSecurityDescriptorBinaryForm(PermissionDescriptor(path, mask, AceFlags.None), AccessControlSections.Access);
                    File.SetAccessControl(path, security);
                }
            } catch (UnauthorizedAccessException error) { throw new Exception("Cannot grant isolated access to '" + path + "'. This path is not permission-manageable by the current user. Use a user-managed toolchain or explicitly approved host execution.", error);
            } finally { if (acquired) mutex.ReleaseMutex(); }
        }
    }

    static void Grant(string input, bool write) {
        string root = ValidateRoot(input, write);
        CheckHardLinks(root);
        FileSystemRights rights = FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
        if (write) rights |= FileSystemRights.Modify;
        int previous; GrantMasks.TryGetValue(root, out previous); GrantMasks[root] = (int)rights | previous;
        ChangePermission(root, GrantMasks[root]);
        if (!GrantedPaths.Contains(root)) GrantedPaths.Add(root);
    }

    static void GrantArray(IDictionary<string, object> config, string key, bool write) {
        object value; if (!config.TryGetValue(key, out value)) return;
        IList values = value as IList; if (values == null || values.Count > 16) throw new Exception("Permission roots must be an array with at most 16 entries.");
        foreach (object path in values) { if (!(path is string)) throw new Exception("Invalid permission root."); Grant((string)path, write); }
    }

    static void Cleanup() {
        Closing = true;
        if (Job != IntPtr.Zero) TerminateJobObject(Job, 130);
        if (ConsoleHandle != IntPtr.Zero) { ClosePseudoConsole(ConsoleHandle); ConsoleHandle = IntPtr.Zero; }
        Close(ref ChildInput); Close(ref Process); Close(ref Job);
        if (ScriptPath != null) { try { File.Delete(ScriptPath); } catch (Exception error) { Emit(new { type = "cleanup_error", message = error.Message }); } }
        for (int i = GrantedPaths.Count - 1; i >= 0; i--) {
            try {
                ChangePermission(GrantedPaths[i], 0);
            } catch (Exception error) { Emit(new { type = "cleanup_error", message = error.Message }); }
        }
        if (ProfileName != null) { int result = DeleteAppContainerProfile(ProfileName); if (result < 0) Emit(new { type = "cleanup_error", message = "Could not remove command profile: 0x" + result.ToString("X8") }); }
        if (ProfileSid != IntPtr.Zero) { FreeSid(ProfileSid); ProfileSid = IntPtr.Zero; }
    }

    static void Pipe(out IntPtr read, out IntPtr write) {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 1 };
        Check(CreatePipe(out read, out write, ref attributes, 0), "CreatePipe");
    }

    static Thread ReadOutput(IntPtr handle, string stream) {
        Thread thread = new Thread(delegate() {
            try {
                using (FileStream output = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false)) {
                    byte[] buffer = new byte[4096]; int count;
                    while ((count = output.Read(buffer, 0, buffer.Length)) > 0) Emit(new { type = "data", stream = stream, data = Convert.ToBase64String(buffer, 0, count) });
                }
            } catch (IOException) { } catch (ObjectDisposedException) { }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }

    static void InputLoop() {
        try {
            string line;
            while (!Closing && (line = Console.ReadLine()) != null) {
                if (line.Length > 2000000) throw new Exception("Input is too large.");
                IDictionary<string, object> input = new JavaScriptSerializer().DeserializeObject(line) as IDictionary<string, object>;
                if (input == null) continue;
                string type = Text(input, "type", "");
                if (type == "close") { Closing = true; if (Job != IntPtr.Zero) TerminateJobObject(Job, 130); break; }
                if (type == "resize" && ConsoleHandle != IntPtr.Zero) HResult(ResizePseudoConsole(ConsoleHandle, new COORD((short)Math.Max(10, Math.Min(500, Number(input, "cols", 100))), (short)Math.Max(3, Math.Min(300, Number(input, "rows", 30))))), "ResizePseudoConsole");
                if (type == "input") {
                    byte[] bytes = Convert.FromBase64String(Text(input, "data", ""));
                    lock (InputLock) { uint written; if (ChildInput != IntPtr.Zero) Check(WriteFile(ChildInput, bytes, (uint)bytes.Length, out written, IntPtr.Zero), "Write stdin"); }
                }
            }
            if (!Closing) { Closing = true; if (Job != IntPtr.Zero) TerminateJobObject(Job, 130); }
        } catch (Exception error) { Emit(new { type = "error", message = "Input channel: " + error.Message }); if (Job != IntPtr.Zero) TerminateJobObject(Job, 130); }
    }

    static IntPtr EnvironmentBlock(IDictionary<string, object> config, string privateHome, bool sandbox) {
        SortedDictionary<string, string> env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string key in new string[] { "SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATH", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "PSModulePath" }) {
            string value = Environment.GetEnvironmentVariable(key); if (value != null) env[key] = value;
        }
        object source; if (config.TryGetValue("env", out source)) {
            IDictionary<string, object> supplied = source as IDictionary<string, object>;
            if (supplied == null) throw new Exception("Invalid environment.");
            foreach (KeyValuePair<string, object> item in supplied) {
                if (item.Key.IndexOf('=') >= 0 || item.Key.IndexOf('\0') >= 0 || !(item.Value is string) || ((string)item.Value).IndexOf('\0') >= 0) throw new Exception("Invalid environment variable.");
                env[item.Key] = (string)item.Value;
            }
        }
        if (sandbox) {
            // No host profile or authentication sockets are passed to commands.
            foreach (string key in new string[] { "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP" }) env[key] = privateHome;
            // Node's default module realpath walks every ancestor up to C:\,
            // which requires metadata access outside the granted workspace.
            // Preserve module paths; Windows still validates their real targets.
            env["NODE_OPTIONS"] = "--preserve-symlinks --preserve-symlinks-main";
        }
        env["CARDWRIGHT_EXECUTION"] = sandbox ? "sandbox" : "host";
        env["TERM"] = "xterm-256color";
        StringBuilder block = new StringBuilder(); foreach (KeyValuePair<string, string> pair in env) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0'); block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    static int Run(IDictionary<string, object> config) {
        string mode = Text(config, "mode", "sandbox");
        if (mode != "sandbox" && mode != "host") throw new Exception("Unknown execution mode.");
        if (Text(config, "network", "off") != "off") throw new Exception("Only offline sandbox execution is supported.");
        bool sandbox = mode == "sandbox", interactive = Flag(config, "interactive");
        bool readOnly = Flag(config, "readOnly");
        object requestedWrites; if (readOnly && config.TryGetValue("writeRoots", out requestedWrites) && requestedWrites is IList && ((IList)requestedWrites).Count != 0) throw new Exception("A read-only command cannot have writable roots.");
        if (readOnly && !sandbox) throw new Exception("Read-only commands require sandbox execution.");
        string cwd = ValidateRoot(Text(config, "cwd", ""));
        string system = Environment.GetFolderPath(Environment.SpecialFolder.System);
        string executable = Path.Combine(system, @"WindowsPowerShell\v1.0\powershell.exe");
        string command = Text(config, "command", "");
        if (!interactive && (command.Length == 0 || command.Length > 200000)) throw new Exception("A command of at most 200000 characters is required.");
        string prefix = "$ProgressPreference='SilentlyContinue'; try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding } catch {}\ntry { " + (sandbox ? "New-PSDrive -Name Workspace -PSProvider FileSystem -Root '" + cwd.Replace("'", "''") + "' -Scope Global -ErrorAction Stop | Out-Null; Set-Location Workspace:\\ -ErrorAction Stop; " : "Set-Location -LiteralPath '" + cwd.Replace("'", "''") + "' -ErrorAction Stop; ") + "[Environment]::CurrentDirectory = '" + cwd.Replace("'", "''") + "' } catch { Write-Error $_; exit 126 };\n";
        string privateHome = null;
        if (sandbox) {
            ProfileName = "Cardwright.Command." + Guid.NewGuid().ToString("N");
            HResult(CreateAppContainerProfile(ProfileName, "Cardwright command", "Temporary offline command container", IntPtr.Zero, 0, out ProfileSid), "CreateAppContainerProfile");
            Sid = new SecurityIdentifier(ProfileSid);
            IntPtr folder; HResult(GetAppContainerFolderPath(Sid.Value, out folder), "GetAppContainerFolderPath");
            privateHome = Marshal.PtrToStringUni(folder); Marshal.FreeCoTaskMem(folder);
            Grant(cwd, !readOnly); GrantArray(config, "readRoots", false); if (!readOnly) GrantArray(config, "writeRoots", true);
        }
        // A script file avoids Windows' 32K command-line limit and PowerShell's
        // encoded-command CLIXML stream. It lives outside the user's project.
        ScriptPath = Path.Combine(sandbox ? privateHome : Path.GetTempPath(), "Cardwright.Command." + Guid.NewGuid().ToString("N") + ".ps1");
        File.WriteAllText(ScriptPath, prefix + command + (interactive ? "" : "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }\n"), new UTF8Encoding(true));
        string arguments = " -NoLogo -NoProfile -ExecutionPolicy Bypass" + (interactive ? " -NoExit" : " -NonInteractive") + " -File \"" + ScriptPath + "\"";
        Job = CreateJobObject(IntPtr.Zero, null); Check(Job != IntPtr.Zero, "CreateJobObject");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = 0x2000;
        IntPtr limitsPtr = Alloc(limits);
        try { Check(SetInformationJobObject(Job, 9, limitsPtr, (uint)Marshal.SizeOf(limits)), "Set kill-on-close job limit"); } finally { Marshal.FreeHGlobal(limitsPtr); }
        IntPtr stdinRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero, stderrWrite = IntPtr.Zero, stdoutRead = IntPtr.Zero, stderrRead = IntPtr.Zero;
        Pipe(out stdinRead, out ChildInput); Pipe(out stdoutRead, out stdoutWrite);
        Check(SetHandleInformation(ChildInput, HANDLE_FLAG_INHERIT, 0), "Protect input handle"); Check(SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0), "Protect output handle");
        if (!interactive) { Pipe(out stderrRead, out stderrWrite); Check(SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0), "Protect error handle"); }
        if (interactive) HResult(CreatePseudoConsole(new COORD((short)Math.Max(10, Math.Min(500, Number(config, "cols", 100))), (short)Math.Max(3, Math.Min(300, Number(config, "rows", 30)))), stdinRead, stdoutWrite, 0, out ConsoleHandle), "CreatePseudoConsole (requires Windows 10 1809 or newer)");
        STARTUPINFOEX startup = new STARTUPINFOEX(); startup.StartupInfo.cb = Marshal.SizeOf(startup);
        // Explicit null standard handles let ConPTY populate its console handles;
        // otherwise Windows can copy this helper's JSON pipes into PowerShell.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        if (!interactive) { startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = stdinRead; startup.StartupInfo.hStdOutput = stdoutWrite; startup.StartupInfo.hStdError = stderrWrite; }
        IntPtr attributeSize = IntPtr.Zero, securityPtr = IntPtr.Zero, handlesPtr = IntPtr.Zero, environment = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, (sandbox ? 1 : 0) + 1, 0, ref attributeSize);
        startup.lpAttributeList = Marshal.AllocHGlobal(attributeSize);
        Check(InitializeProcThreadAttributeList(startup.lpAttributeList, (sandbox ? 1 : 0) + 1, 0, ref attributeSize), "Initialize process attributes");
        try {
            if (sandbox) { SECURITY_CAPABILITIES security = new SECURITY_CAPABILITIES { AppContainerSid = ProfileSid }; securityPtr = Alloc(security); Check(UpdateProcThreadAttribute(startup.lpAttributeList, 0, new IntPtr(0x20009), securityPtr, new IntPtr(Marshal.SizeOf(security)), IntPtr.Zero, IntPtr.Zero), "Apply AppContainer identity"); }
            if (interactive) Check(UpdateProcThreadAttribute(startup.lpAttributeList, 0, new IntPtr(0x20016), ConsoleHandle, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Apply pseudoconsole");
            else { IntPtr[] handles = new IntPtr[] { stdinRead, stdoutWrite, stderrWrite }; handlesPtr = Marshal.AllocHGlobal(IntPtr.Size * handles.Length); Marshal.Copy(handles, 0, handlesPtr, handles.Length); Check(UpdateProcThreadAttribute(startup.lpAttributeList, 0, new IntPtr(0x20002), handlesPtr, new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero), "Whitelist inherited handles"); }
            environment = EnvironmentBlock(config, privateHome, sandbox);
            PROCESS_INFORMATION process;
            Check(CreateProcess(executable, new StringBuilder("\"" + executable + "\"" + arguments), IntPtr.Zero, IntPtr.Zero, !interactive, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | (interactive ? 0u : CREATE_NO_WINDOW), environment, cwd, ref startup, out process), "Create isolated PowerShell");
            Process = process.hProcess;
            try { Check(AssignProcessToJobObject(Job, Process), "Attach child to job"); Check(ResumeThread(process.hThread) != 0xffffffff, "Resume child"); } catch { TerminateProcess(Process, 126); throw; } finally { CloseHandle(process.hThread); }
            Emit(new { type = "started", pid = process.dwProcessId, mode = mode, network = sandbox ? "off" : "host", interactive = interactive });
        } finally {
            DeleteProcThreadAttributeList(startup.lpAttributeList); Marshal.FreeHGlobal(startup.lpAttributeList);
            if (securityPtr != IntPtr.Zero) Marshal.FreeHGlobal(securityPtr); if (handlesPtr != IntPtr.Zero) Marshal.FreeHGlobal(handlesPtr); if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            Close(ref stdinRead); Close(ref stdoutWrite); Close(ref stderrWrite);
        }
        Thread stdout = ReadOutput(stdoutRead, "stdout"), stderr = interactive ? null : ReadOutput(stderrRead, "stderr");
        Thread inputThread = new Thread(InputLoop); inputThread.IsBackground = true; inputThread.Start();
        int timeout = Number(config, "timeoutMs", interactive ? 0 : 120000);
        uint result = WaitForSingleObject(Process, timeout <= 0 ? 0xffffffff : (uint)Math.Min(timeout, 86400000));
        if (result == 0x102) { TimedOut = true; TerminateJobObject(Job, 124); WaitForSingleObject(Process, 5000); }
        else if (result != 0) throw new Exception("Could not wait for command process.");
        uint exitCode; Check(GetExitCodeProcess(Process, out exitCode), "Get command exit code");
        Closing = true;
        // A completed command owns no surviving background children or pipe writers.
        TerminateJobObject(Job, 130);
        if (ConsoleHandle != IntPtr.Zero) { ClosePseudoConsole(ConsoleHandle); ConsoleHandle = IntPtr.Zero; }
        stdout.Join(3000); if (stderr != null) stderr.Join(3000);
        Emit(new { type = "exit", exitCode = TimedOut ? 124 : (int)exitCode, timedOut = TimedOut });
        return 0;
    }

    public static int Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        try { string line = Console.ReadLine(); if (line == null || line.Length > 4000000) throw new Exception("Missing or oversized command job."); IDictionary<string, object> config = Json.DeserializeObject(line) as IDictionary<string, object>; if (config == null) throw new Exception("Invalid command job."); return Run(config); }
        catch (Exception error) { Emit(new { type = "error", message = error.Message }); return 126; }
        finally { Cleanup(); }
    }

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public int CapabilityCount; public int Reserved; }
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; public COORD(short x, short y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint VolumeSerial, SizeHigh, SizeLow, NumberOfLinks, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, int count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION information);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr handle, byte[] data, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console, COORD size);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
}

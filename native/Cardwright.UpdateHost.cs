// A detached, offline supervisor. The running app closes all tasks before launching it.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class UpdateHost {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    static Dictionary<string, object> Job;
    static string Root, DataDir, ReportPath;
    static string S(IDictionary<string, object> value, string key) { object result; if (!value.TryGetValue(key,out result) || !(result is string)) throw new Exception("Missing update field: " + key); return (string)result; }
    static int N(string key, int fallback) { object value; return Job.TryGetValue(key,out value) ? Convert.ToInt32(value) : fallback; }
    static Dictionary<string, object> Map(string key) { object value; return Job.TryGetValue(key,out value) ? value as Dictionary<string,object> : null; }
    static string Full(string path) { if (!Path.IsPathRooted(path) || path.StartsWith(@"\\") || path.Replace(Path.GetPathRoot(path), "").Contains(":")) throw new Exception("Update paths must be normal local absolute paths."); return Path.GetFullPath(path); }
    static bool Inside(string root, string path) { return Full(path).StartsWith(Full(root).TrimEnd('\\') + "\\",StringComparison.OrdinalIgnoreCase); }
    static string Hash(string path) { using (FileStream stream=File.OpenRead(path)) using (SHA256 sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    static string Verify(Dictionary<string,object> package) { if(package==null)throw new Exception("Installer details missing.");string path=Full(S(package,"path"));if(!Inside(Root,path)||!path.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)||Hash(path)!=S(package,"sha256").ToLowerInvariant())throw new Exception("Installer checksum or location changed.");return path; }
    static void Report(string status, string message) { string temporary=ReportPath+".tmp"; File.WriteAllText(temporary,Json.Serialize(new {status=status,message=message,at=DateTime.UtcNow.ToString("o")}),new UTF8Encoding(false));if(File.Exists(ReportPath))File.Delete(ReportPath);File.Move(temporary,ReportPath); }
    static void Kill(Process process) {
        if(process==null)return;try {if(process.HasExited)return;using(Process killer=Process.Start(new ProcessStartInfo {FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"taskkill.exe"),Arguments="/PID "+process.Id+" /T /F",UseShellExecute=false,CreateNoWindow=true}))killer.WaitForExit(10000);}catch{};
    }
    static void WaitParent() {
        int pid=N("parentPid",0); if(pid<=0)throw new Exception("Missing parent process.");
        try {using(Process parent=Process.GetProcessById(pid)) {if(!parent.WaitForExit(Math.Min(120000,Math.Max(1000,N("waitParentMs",30000)))))throw new Exception("Cardwright did not close. No installer was launched.");}}catch(ArgumentException){};
    }
    static void RestoreData(string backup) {
        backup=Full(backup);if(!Inside(Path.Combine(Root,"backups"),backup)||!File.Exists(backup))throw new Exception("A compatible state backup is unavailable.");
        if(new FileInfo(backup).Length>536870912)throw new Exception("The state backup is too large.");
        string content=File.ReadAllText(backup,Encoding.UTF8);if(!(new JavaScriptSerializer {MaxJsonLength=536870912}.DeserializeObject(content) is Dictionary<string,object>))throw new Exception("The compatible state backup is invalid.");
        string credentialBackup=Full(S(Job,"credentialsBackup")),receiptPath=Full(S(Job,"credentialsReceipt"));
        if(!Inside(Path.Combine(Root,"backups"),credentialBackup)||!Inside(Path.Combine(Root,"backups"),receiptPath)||!File.Exists(receiptPath))throw new Exception("The compatible encrypted credential snapshot is unavailable.");
        Dictionary<string,object> receipt=Json.DeserializeObject(File.ReadAllText(receiptPath,Encoding.UTF8)) as Dictionary<string,object>;object present;
        if(receipt==null||!receipt.TryGetValue("present",out present)||!(present is bool))throw new Exception("Invalid encrypted credential snapshot receipt.");
        bool haveCredentials=(bool)present;if(haveCredentials&&(!File.Exists(credentialBackup)||Hash(credentialBackup)!=S(receipt,"sha256")))throw new Exception("Encrypted credential snapshot changed.");
        string credentialTarget=Path.Combine(DataDir,"credentials.enc.json");if(File.Exists(credentialTarget))File.Copy(credentialTarget,Path.Combine(Root,"backups","credentials-before-failed-update.enc.json"),true);
        if(File.Exists(credentialTarget))File.Delete(credentialTarget);
        string state=Path.Combine(DataDir,"state.json"),temporary=Path.Combine(DataDir,".state-update-restore.tmp");
        if(File.Exists(state))File.Copy(state,Path.Combine(Root,"backups","state-before-failed-update.json"),true);
        File.WriteAllText(temporary,content,new UTF8Encoding(false));if(File.Exists(state))File.Replace(temporary,state,null);else File.Move(temporary,state);
        object studio; if(Job.TryGetValue("studioBackup",out studio)&&studio is string&&File.Exists((string)studio)) {string source=Full((string)studio);if(!Inside(Path.Combine(Root,"backups"),source))throw new Exception("Invalid Studio backup path.");File.Copy(source,Path.Combine(DataDir,"studio.json"),true);}
        try{if(haveCredentials){string staged=Path.Combine(DataDir,".credentials-update-restore.tmp");File.Copy(credentialBackup,staged,true);if(File.Exists(credentialTarget))File.Replace(staged,credentialTarget,null);else File.Move(staged,credentialTarget);}else if(File.Exists(credentialTarget))File.Delete(credentialTarget);}catch{if(File.Exists(credentialTarget))File.Delete(credentialTarget);throw;}
    }
    static void Installer(Dictionary<string,object> package) {
        string path=Verify(package),directory=Full(S(Job,"targetDirectory"));
        if(directory.TrimEnd('\\').Length<4||directory.Contains("\""))throw new Exception("Invalid installation directory.");
        ProcessStartInfo info=new ProcessStartInfo {FileName=path,Arguments="/S /currentuser /D="+directory,UseShellExecute=false,CreateNoWindow=true};info.EnvironmentVariables["CARDWRIGHT_DATA_DIR"]=DataDir;
        using(Process process=Process.Start(info)) {if(process==null)throw new Exception("Installer did not start.");if(!process.WaitForExit(Math.Max(1000,Math.Min(900000,N("installerTimeoutMs",300000))))){Kill(process);throw new Exception("Installer timed out.");}if(process.ExitCode!=0)throw new Exception("Installer returned exit code "+process.ExitCode+".");}
    }
    static void HealthyLaunch() {
        string executable=Full(S(Job,"executable")),directory=Full(S(Job,"targetDirectory"));
        if(!executable.Equals(Path.Combine(directory,"Cardwright.exe"),StringComparison.OrdinalIgnoreCase)||!File.Exists(executable))throw new Exception("Installed Cardwright.exe is unavailable.");
        string health=Full(S(Job,"healthFile")),token=S(Job,"healthToken");if(!Inside(Root,health)||token.Length<20)throw new Exception("Invalid startup health marker.");
        if(File.Exists(health))File.Delete(health);
        ProcessStartInfo info=new ProcessStartInfo {FileName=executable,UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=directory};info.EnvironmentVariables["CARDWRIGHT_DATA_DIR"]=DataDir;info.EnvironmentVariables["CARDWRIGHT_UPDATE_HEALTH_FILE"]=health;info.EnvironmentVariables["CARDWRIGHT_UPDATE_HEALTH_TOKEN"]=token;
        using(Process process=Process.Start(info)) {
            if(process==null)throw new Exception("Updated Cardwright did not start.");
            DateTime deadline=DateTime.UtcNow.AddMilliseconds(Math.Max(1000,Math.Min(120000,N("healthTimeoutMs",45000))));
            while(DateTime.UtcNow<deadline) {
                if(File.Exists(health)) {try {if(File.ReadAllText(health,Encoding.UTF8)==token)return;}catch(IOException){}}
                if(process.HasExited)throw new Exception("Updated Cardwright exited before it was ready.");Thread.Sleep(100);
            }
            Kill(process);throw new Exception("Updated Cardwright did not pass its startup health check.");
        }
    }
    public static int Main(string[] args) {
        try {
            if(args.Length!=1)throw new Exception("Expected one update job file.");
            string jobPath=Full(args[0]);Job=Json.DeserializeObject(File.ReadAllText(jobPath,Encoding.UTF8)) as Dictionary<string,object>;if(Job==null||N("format",0)!=1)throw new Exception("Invalid update job.");
            DataDir=Full(S(Job,"dataDir"));Root=Path.Combine(DataDir,"updates");string report=Full(S(Job,"reportPath"));if(!Inside(Root,jobPath)||!Inside(Root,report))throw new Exception("The update job must belong to the application data directory.");ReportPath=report;
            Dictionary<string,object> installer=Map("installer"),previous=Map("previous");Verify(installer);if(previous!=null)Verify(previous);
            string backup=Full(S(Job,"backup"));if(!Inside(Path.Combine(Root,"backups"),backup))throw new Exception("Invalid backup location.");
            WaitParent();Report("installing","Cardwright closed; installing the verified local package.");
            try {if(S(Job,"action")=="rollback")RestoreData(backup);Installer(installer);HealthyLaunch();Report(S(Job,"action")=="rollback"?"rolled_back":"installed","Installation passed startup verification.");return 0;}
            catch(Exception failure) {
                if(previous==null){object portable;bool untouched=Job.TryGetValue("portableSource",out portable)&&portable is bool&&(bool)portable;Report("failed",failure.Message+(untouched?" No previous installer is cached; the original portable directory is unchanged.":" No previous installer is cached; manual recovery is required."));return 1;}
                try {RestoreData(backup);Installer(previous);HealthyLaunch();Report("rolled_back",failure.Message+" The previous installer and compatible data were restored.");return 0;}
                catch(Exception rollback){Report("rollback_failed",failure.Message+" Recovery requires attention: "+rollback.Message);return 2;}
            }
        } catch(Exception error) {if(ReportPath!=null){try{Report("failed",error.Message);}catch{}}Console.Error.WriteLine(error.Message);return 3;}
    }
}

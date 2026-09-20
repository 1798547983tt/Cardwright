/** What the harness needs from the built-in browser; the window owns the real one (§6.4). */
export interface BrowserBridge {
  open(url: string, options?: { tabId?: string }): Promise<{ tabId: string } | { needsPermission: string }>;
  readText(tabId?: string): Promise<string>;
  structure(tabId?: string): Promise<{ title: string; url: string; items: Array<Record<string, unknown>> }>;
  find(text: string, tabId?: string): Promise<Array<Record<string, unknown>>>;
  submits(ref: string, tabId?: string): Promise<boolean>;
  click(ref: string, tabId?: string): Promise<string>;
  type(ref: string, text: string, tabId?: string): Promise<string>;
  screenshot(tabId?: string): Promise<{ data: string; width: number; height: number }>;
  consoleLines(tabId?: string): string[];
  networkLines(tabId?: string): Array<{ url: string; status?: number; method: string }>;
}

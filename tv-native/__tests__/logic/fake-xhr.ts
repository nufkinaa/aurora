// A scripted XMLHttpRequest for api.ts's fetchBounded: answers are queued in
// order, and every request made is recorded.
export type Answer = {status: number; body?: string; etag?: string | null; fail?: boolean};
export const sent: {url: string; method: string; headers: Record<string, string>}[] = [];
let answers: Answer[] = [];
export const queue = (...a: Answer[]) => {
  answers.push(...a);
};
export const resetXhr = () => {
  sent.length = 0;
  answers = [];
};

class FakeXHR {
  readyState = 0;
  status = 0;
  statusText = '';
  response = '';
  responseType = '';
  onprogress: null | (() => void) = null;
  onreadystatechange: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onabort: null | (() => void) = null;
  onload: null | (() => void) = null;
  private url = '';
  private method = 'GET';
  private headers: Record<string, string> = {};
  private etag: string | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getAllResponseHeaders() {
    return 'Content-Type: application/json\r\n' + (this.etag ? `ETag: ${this.etag}\r\n` : '');
  }
  abort() {}
  send() {
    sent.push({url: this.url, method: this.method, headers: this.headers});
    const a = answers.shift();
    if (!a) throw new Error(`no answer queued for ${this.url}`);
    setTimeout(() => {
      if (a.fail) return this.onerror?.();
      this.status = a.status;
      this.response = a.body || '';
      this.etag = a.etag ?? null;
      this.readyState = 4;
      this.onload?.();
    }, 0);
  }
}
(globalThis as unknown as {XMLHttpRequest: unknown}).XMLHttpRequest = FakeXHR;

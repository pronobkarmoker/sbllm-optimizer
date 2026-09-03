import * as vscode from 'vscode';
import http from 'node:http';
import { URL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Connectivity self-test, run from inside the extension host.
 *
 * The extension host is the one environment that cannot be reproduced from a terminal: the same
 * Ollama request that succeeds from plain Node, from a bundled CJS build, and from curl has failed
 * here in two different ways (global fetch reporting only "fetch failed", then node:http returning
 * HTTP 200 with an empty body). Rather than ask someone to transcribe an error message, this probes
 * several transports side by side and writes a report to a fixed path.
 */
const REPORT_PATH = path.join(tmpdir(), 'sbllm-diagnostics.json');

interface Probe {
  name: string;
  ok: boolean;
  detail: string;
}

function rawHttpProbe(host: string, useAgentFalse: boolean, timeoutMs = 30_000): Promise<Probe> {
  const name = `node:http (agent:${useAgentFalse ? 'false' : 'default'})`;
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL('/api/tags', host);
    } catch {
      return resolve({ name, ok: false, detail: `invalid host URL: ${host}` });
    }
    const opts: http.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'GET',
      headers: { Accept: 'application/json' },
    };
    if (useAgentFalse) (opts as { agent?: false }).agent = false;

    const req = http.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        resolve({
          name,
          ok: (res.statusCode ?? 0) === 200 && body.trim() !== '',
          detail:
            `HTTP ${res.statusCode} ${res.statusMessage ?? ''} | bytes=${body.length} | ` +
            `server=${String(res.headers['server'] ?? '-')} | via=${String(res.headers['via'] ?? '-')} | ` +
            `content-type=${String(res.headers['content-type'] ?? '-')} | first=${JSON.stringify(body.slice(0, 90))}`,
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', (e) =>
      resolve({ name, ok: false, detail: `${(e as NodeJS.ErrnoException).code ?? ''} ${e.message}`.trim() }),
    );
    req.end();
  });
}

async function fetchProbe(host: string): Promise<Probe> {
  const name = 'global fetch';
  try {
    const res = await fetch(new URL('/api/tags', host).toString());
    const body = await res.text();
    return {
      name,
      ok: res.status === 200 && body.trim() !== '',
      detail: `HTTP ${res.status} | bytes=${body.length} | first=${JSON.stringify(body.slice(0, 90))}`,
    };
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    return { name, ok: false, detail: `${(err as Error).message} | cause=${cause?.code ?? cause?.message ?? 'none'}` };
  }
}

export async function runDiagnosticsCommand(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('sbllmOptimizer');
  const host = cfg.get<string>('ollamaHost', 'http://127.0.0.1:11434');
  const httpCfg = vscode.workspace.getConfiguration('http');

  const probes: Probe[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'SBLLM: running connection diagnostics' },
    async () => {
      probes.push(await rawHttpProbe(host, true));
      probes.push(await rawHttpProbe(host, false));
      probes.push(await fetchProbe(host));
    },
  );

  const report = {
    when: new Date().toISOString(),
    ollamaHost: host,
    // The prime suspects: VS Code patches extension-host networking for proxy support, and these
    // are the settings that govern it.
    vscodeHttpSettings: {
      proxy: httpCfg.get('proxy'),
      proxySupport: httpCfg.get('proxySupport'),
      proxyStrictSSL: httpCfg.get('proxyStrictSSL'),
      noProxy: httpCfg.get('noProxy'),
      proxyAuthorization: httpCfg.get('proxyAuthorization') ? '<set>' : undefined,
    },
    env: {
      HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null,
      NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy ?? null,
    },
    versions: { vscode: vscode.version, node: process.version, platform: process.platform },
    probes,
  };

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

  const anyOk = probes.some((p) => p.ok);
  const summary = probes.map((p) => `${p.ok ? 'OK  ' : 'FAIL'} ${p.name}: ${p.detail}`).join('\n');

  const doc = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(report, null, 2),
  });
  await vscode.window.showTextDocument(doc, { preview: false });

  void vscode.window.showInformationMessage(
    anyOk
      ? 'SBLLM: at least one transport reached Ollama — see the report for which.'
      : 'SBLLM: no transport could reach Ollama from the extension host — see the report.',
    { modal: false, detail: summary } as vscode.MessageOptions,
  );
}

export { REPORT_PATH };

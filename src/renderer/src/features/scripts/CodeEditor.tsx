import type { ScriptKind } from '../../../../shared/scripts'
import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker'

import * as typescript from 'monaco-editor/languages/features/typescript/register'
import { useEffect, useRef } from 'react'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/indentation/browser/indentation'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints';

(globalThis as typeof globalThis & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => label === 'javascript' || label === 'typescript' ? new TypeScriptWorker() : new EditorWorker()
}
typescript.javascriptDefaults.setCompilerOptions({ target: typescript.ScriptTarget.ESNext, allowNonTsExtensions: true, allowJs: true, checkJs: false })
typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, diagnosticCodesToIgnore: [1108, 1375, 1378] })
const CAPTURE_TYPES = `
interface OctoCaptureFilter { siteId?: string; external?: boolean; url?: string; method?: string; status?: number; from?: number; to?: number; limit?: number; cursor?: string }
interface OctoCaptureState { status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'; port: number; pending: boolean }
interface OctoCaptureRecord { id: string; source: { id: string; siteId?: string; generation?: string; name: string }; url: string; method: string; status?: number; startedAt: number; endedAt?: number; error?: string }
interface OctoCaptureBody { text?: string; base64?: string; encoding?: string; contentEncoding?: string; decoded: boolean; pending: boolean; truncated: boolean; unavailable: boolean; size: number; wireSize: number }
interface OctoCapturePart { headers: { name: string; value: string }[]; body: OctoCaptureBody }
interface OctoCapture {
  /** 需桌面总开关和脚本本机授权。行动、注入仅当前网站；沙箱全部来源。 */
  status(): Promise<OctoCaptureState>;
  query(filter?: OctoCaptureFilter): Promise<{ items: OctoCaptureRecord[]; generation: string; cursor?: string }>;
  get(id: string): Promise<OctoCaptureRecord & { request: OctoCapturePart; response: OctoCapturePart }>;
  /** 另需 control 授权；有关联网站时不能停止代理。 */
  start(): Promise<OctoCaptureState>; stop(): Promise<OctoCaptureState>;
}
`
const NODE_TYPES = `
/** 支持当前 Node.js 内置模块，以及已声明并安装的第三方依赖。 */
declare function require(name: string): any;
declare const process: { cwd(): string; env: Record<string, string | undefined>; versions: { node: string }; pid: number; stdout: { write(text: string): boolean }; stderr: { write(text: string): boolean }; exit(code?: number): never };
declare const Buffer: { from(value: string | number[], encoding?: string): any; alloc(size: number): any; byteLength(value: string): number };
`
const BROWSER_TYPES = `
interface OctoHeader { name: string; value: string }
interface OctoRequest { url: string; method: string; headers: OctoHeader[]; postData?: string; resourceType: string }
interface OctoResponse { status: number; headers: OctoHeader[]; body: string }
interface OctoPage {
  url(): string; title(): Promise<string>; content(): Promise<string>;
  goto(url: string, options?: object): Promise<unknown>;
  waitForSelector(selector: string, options?: object): Promise<unknown>;
  click(selector: string): Promise<void>; type(selector: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  evaluateOnNewDocument(fn: (...args: any[]) => unknown, ...args: any[]): Promise<{identifier: string}>;
  on(event: string, listener: (...args: any[]) => unknown): OctoPage;
  off(event: string, listener: (...args: any[]) => unknown): OctoPage;
  $eval<T>(selector: string, fn: (element: any) => T): Promise<T>;
  $$eval<T>(selector: string, fn: (elements: any[]) => T): Promise<T>;
}
declare const page: OctoPage;
declare const browser: { connected: boolean; pages(): Promise<OctoPage[]>; newPage(): Promise<OctoPage> };
declare const octo: {
  capture: OctoCapture;
  site: { id: string; name: string; url: string; tabId: string; currentUrl: string };
  vars: Record<string, string | number | boolean>;
  log(...args: unknown[]): void; sleep(ms: number): Promise<void>; output(value: unknown): void;
  /** 后台提交通知；不等待网络，不影响脚本结果。最终结果查看通知日志。 */
  notify(target: string | string[], message: string | { title?: string; content: string }): void;
  onDispose(callback: () => unknown): void;
  interceptRequest(options: {urlPattern: string}, handler: (request: OctoRequest) => Partial<OctoRequest> | {abort: boolean} | {respond: Partial<OctoResponse> & {status: number}} | void | Promise<unknown>): () => void;
  interceptResponse(options: {urlPattern: string}, handler: (event: {request: OctoRequest; response: OctoResponse}) => Partial<OctoResponse> | void | Promise<unknown>): () => void;
};
`
const SANDBOX_TYPES = `
declare const octo: {
  capture: OctoCapture;
  vars: Record<string, string | number | boolean>;
  log(...args: unknown[]): void; sleep(ms: number): Promise<void>;
  /** 一次性暂存结果；常驻更新最新 JSON 快照，上限 64K 字符。 */
  output(value: unknown): void;
  /** 停止时逆序调用，最多等待 3 秒。外部子进程需自行清理。 */
  onDispose(callback: () => unknown): void;
  notify(target: string | string[], message: string | { title?: string; content: string }): void;
};
`

export default function CodeEditor({ value = '', onChange, id, kind = 'action' }: { value?: string; onChange?(value: string): void; id?: string; kind?: ScriptKind }) {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(null)
  const callback = useRef(onChange)
  callback.current = onChange
  const initial = useRef(value)
  useEffect(() => {
    const library = typescript.javascriptDefaults.addExtraLib(CAPTURE_TYPES + NODE_TYPES + (kind === 'sandbox' ? SANDBOX_TYPES : BROWSER_TYPES), 'ts:octo-runtime.d.ts')
    return () => library.dispose()
  }, [kind])
  useEffect(() => {
    const model = monaco.editor.createModel(initial.current, 'javascript')
    const instance = monaco.editor.create(container.current!, {
      model, ariaLabel: 'JavaScript 源码', automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
      lineHeight: 21, tabSize: 2, insertSpaces: true, scrollBeyondLastLine: false, wordWrap: 'on',
      stickyScroll: { enabled: false }, padding: { top: 12 }, bracketPairColorization: { enabled: true }
    })
    editor.current = instance
    const listener = instance.onDidChangeModelContent(() => callback.current?.(instance.getValue()))
    return () => { listener.dispose(); instance.dispose(); model.dispose(); editor.current = null }
  }, [])
  useEffect(() => {
    if (editor.current && value !== editor.current.getValue()) editor.current.setValue(value)
  }, [value])
  return <div ref={container} id={id} className="script-code-editor" data-testid="script-code-editor" />
}

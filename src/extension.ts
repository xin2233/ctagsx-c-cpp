// import * as ctagz from 'ctagz'
import { CTagEntry as ParsedCTagEntry, findCTagsBSearch } from './ctags'
import * as path from 'path'
import * as vscode from 'vscode'
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as readline from 'readline'

interface JumpPosition {
    uri: string
    lineNumber: number
    charPos: number
}

type CTagEntry = ParsedCTagEntry

interface CTagQuickPickItem extends vscode.QuickPickItem {
    entry: CTagEntry
}

// Called when the plugin is first activated
export function activate(context: vscode.ExtensionContext): void {
    console.log('ctagsc is live')

    let disposable = vscode.commands.registerCommand('extension.findCTags', () => findCTagsInDocument(context))
    context.subscriptions.push(disposable)

    disposable = vscode.commands.registerCommand('extension.findCTagsPrompt', () => findCTagsFromPrompt(context))
    context.subscriptions.push(disposable)

    disposable = vscode.commands.registerCommand('extension.ctagsJumpBack', () => jumpBack(context))
    context.subscriptions.push(disposable)

    disposable = vscode.commands.registerCommand('extension.ctagsClearJumpStack', () => clearJumpStack(context))
    context.subscriptions.push(disposable)

    disposable = vscode.commands.registerCommand('extension.createTerminal', createTerminal)
    context.subscriptions.push(disposable)

    disposable = vscode.commands.registerCommand('extension.generateCTags', generateCTags)
    context.subscriptions.push(disposable)

    if (!vscode.workspace.getConfiguration('ctagsc').get('disableDefinitionProvider')) {
        disposable = vscode.languages.registerDefinitionProvider({ pattern: '**/*' }, { provideDefinition })
        context.subscriptions.push(disposable)
    }
}

// Called when the plugin is deactivated
export function deactivate(): void {
    console.log('ctagsc is deactivated')
}

function resolveCTagEntry(entry: ParsedCTagEntry, tagsFile: string): CTagEntry {
    const resolvedFile = path.isAbsolute(entry.file)
        ? entry.file
        : path.join(path.dirname(tagsFile), entry.file)

    return {
        ...entry,
        file: resolvedFile
    }
}

function toQuickPickEntry(entry: ParsedCTagEntry, tagsFile: string): CTagQuickPickItem {
    const resolvedEntry = resolveCTagEntry(entry, tagsFile)

    return {
        entry: resolvedEntry,
        label: resolvedEntry.file,
        description: resolvedEntry.kind || '',
        detail: resolvedEntry.address.pattern || 'Line ' + resolvedEntry.address.lineNumber
    }
}

/**
 * Regenerate ctags
 */
function doGenerate(): Promise<string> {
    const config = vscode.workspace.getConfiguration('ctagsc')
    const command = config.get<string>('generateCTagsCommand')
    if (vscode.workspace.workspaceFolders) {
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/')
        console.log(`Running ctagsc command: ${command}`)
        console.log(`workspacePath pwd :  ${workspacePath}`)
        return new Promise<string>((resolve, reject) => {
            child_process.exec(command || 'ctags --tag-relative --extras=+f -R .', { cwd: workspacePath }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`exec error: ${error}`)
                    reject(error)
                } else if (stderr) {
                    console.error(`stderr: ${stderr}`)
                    reject(stderr)
                } else {
                    resolve(stdout)
                }
            })
        })
    } else {
        return Promise.reject('No workspace folder is open')
    }
}

function generateCTags(): Thenable<void> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: 'Generating CTags...'
        },
        (_progress, _token) => {
            return doGenerate()
                .catch(err => {
                    vscode.window.setStatusBarMessage('Generating CTags failed!!')
                    vscode.window.showErrorMessage(`Generating CTags failed: ${err}`)
                }) as Thenable<void>
        }
    )
}

function createTerminal(): void {
    vscode.window.createTerminal().show()
}

async function findCTagsFromPrompt(context: vscode.ExtensionContext): Promise<void> {
    const options: vscode.InputBoxOptions = {
        prompt: 'Enter a tag to search for'
    };
    const tag = await vscode.window.showInputBox(options);
    if (!tag) {
        return;
    }
    await findCTags(context, tag);
}
/**
 * Find ctags for a tag in the current document, CTRL+T
 */
async function findCTagsInDocument(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        console.log('ctags: Cannot search - no active editor');
        return;
    }

    const tag = getTag(editor);
    if (!tag) {
        return;
    }

    await findCTags(context, tag);
}
/**
 * Find ctags for a tag, CTRL+T
 */
async function findCTags(context: vscode.ExtensionContext, tag: string): Promise<void>  {
    const editor = vscode.window.activeTextEditor
    let searchPath: string | undefined = vscode.workspace.rootPath

    if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
        searchPath = editor.document.fileName
    }

    if (!searchPath) {
        console.log('ctags: Could not get a path to search for tags file')
        if (editor) {
            console.log('ctags: Document is untitled? ', editor.document.isUntitled)
            console.log('ctags: Document URI:', editor.document.uri.toString())
        } else {
            console.log('ctags: Active text editor is undefined')
        }
        console.log('ctags: Workspace root: ', vscode.workspace.rootPath)
        vscode.window.showWarningMessage(`ctags: No searchable path (no workspace folder open?)`)
        return
    }

    try {
        const result = await findCTagsBSearch(searchPath, tag)
        const options: CTagQuickPickItem[] = result.results.map(entry => {
            const option = toQuickPickEntry(entry, result.tagsFile)
            console.log('tag :', option)
            return option
        })

        if (!options.length) {
            if (!result.tagsFile) {
                vscode.window.showWarningMessage(`ctags: No tags file found`);
            } else {
                vscode.window.showInformationMessage(`ctags: No tags found for ${tag}`);
            }
            return;
        } else if (options.length === 1) {
            await revealCTags(context, editor, options[0].entry);
        } else {
            const opt = await vscode.window.showQuickPick(options);
            if (opt) {
                await revealCTags(context, editor, opt.entry);
            }
        }
    } catch (err) {
        if (err instanceof Error) {
            console.log(err.stack);
        } else {
            console.log(err);
        }
        vscode.window.showErrorMessage(`ctags: Search failed: ${err}`);
    }
}

/**
 * 鎻愪緵瀹氫箟鍑芥暟
 */
async function provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    canceller: vscode.CancellationToken
): Promise<vscode.Location[]> {
    if (document.isUntitled || document.uri.scheme !== 'file') {
        console.log('ctags: Cannot provide definitions for untitled (unsaved) and/or non-local (non file://) documents')
        return Promise.reject(new Error('untitled or non-local document'))
    }

    let tag: string | undefined
    let range: vscode.Range | vscode.Selection | undefined
    const editor = vscode.window.activeTextEditor

    if (editor && editor.document === document && position.isEqual(editor.selection.active)) {
        range = editor.selection
        tag = editor.document.getText(editor.selection).trim()
    }

    if (!tag) {
        range = document.getWordRangeAtPosition(position)
        if (!range) {
            console.log('ctags: Cannot provide definition without a valid tag (word range)')
            return Promise.reject(new Error('no word range'))
        }
        tag = document.getText(range)
        if (!tag) {
            console.log('ctags: Cannot provide definition with an empty tag')
            return Promise.reject(new Error('empty tag'))
        }
    }

    try {
        // 浣跨敤ctagz妯″潡鏌ユ壘鏍囩
        const result = await findCTagsBSearch(document.fileName, tag)
        // 灏嗙粨鏋滀腑鐨勬爣绛捐浆鎹负vscode.Location瀵硅薄
        const options: CTagEntry[] = result.results.map(entry => resolveCTagEntry(entry, result.tagsFile))

        const results: vscode.Location[] = []
        // 閬嶅巻姣忎釜鏍囩
        for (const item of options) {
            if (canceller.isCancellationRequested) {
                // 濡傛灉鍙栨秷璇锋眰琚Е鍙戯紝鎻愬墠杩斿洖绌烘暟缁?
                break
            }
            // 鑾峰彇鏍囩鍦ㄦ枃妗ｄ腑鐨勪綅缃紝鍙兘鏈夊涓綅缃紝閮芥坊鍔犲埌缁撴灉涓?
            // await 鍏抽敭瀛椾細绛夊緟 getLineNumber 杩斿洖鐨?Promise 瀹屾垚锛屽苟瑙ｆ瀽鍑鸿 Promise 鐨勭粨鏋溿€傚洜姝わ紝selections 涓嶅啀鏄?Promise锛岃€屾槸 getLineNumber 瀹為檯杩斿洖鐨勫€硷紙姣斿 vscode.Selection[] 绫诲瀷锛夈€傛崲鍙ヨ瘽璇达紝await 甯綘鈥滆В寮€鈥濅簡 Promise 鐨勫寘瑁呫€?
            const selections = await getLineNumber(item, document, range as vscode.Selection, canceller)
            if (Array.isArray(selections)) {
                selections.forEach(sel => {
                    console.log(`provideDefinitio - sel:\n`, sel)
                    results.push(new vscode.Location(vscode.Uri.file(item.file), sel.start))
                })
            }
        }


        return results

    } catch (err) {
        // console.log(err.stack)
        if (err instanceof Error) {
            console.log(err.stack);
        } else {
            console.log(err);
        }
        vscode.window.showErrorMessage(`ctags: Search failed: ${err}`)
        return [];
    }
}

/**
 * ALT+T
 */
function jumpBack(context: vscode.ExtensionContext): void {
    const stack: JumpPosition[] = context.workspaceState.get('CTAGSC_JUMP_STACK', [])
    if (stack.length > 0) {
        const position = stack.pop()!
        context.workspaceState.update('CTAGSC_JUMP_STACK', stack)
            .then(() => {
                const uri = vscode.Uri.parse(position.uri)
                const sel = new vscode.Selection(position.lineNumber, position.charPos, position.lineNumber, position.charPos)
                return openAndReveal(context, vscode.window.activeTextEditor, uri, sel)
            })
    }
}

function clearJumpStack(context: vscode.ExtensionContext): Thenable<void> {
    return context.workspaceState.update('CTAGSC_JUMP_STACK', [])
}

/**
 * 淇濆瓨褰撳墠缂栬緫鍣ㄧ殑浣嶇疆
 */
function saveState(
    context: vscode.ExtensionContext,
    editor: vscode.TextEditor | undefined
): Thenable<void> {
    if (!editor) {
        return Promise.resolve()
    }
    const currentPosition: JumpPosition = {
        uri: editor.document.uri.toString(),
        lineNumber: editor.selection.active.line,
        charPos: editor.selection.active.character
    }

    const stack: JumpPosition[] = context.workspaceState.get('CTAGSC_JUMP_STACK', [])
    if (stack.length > 0) {
        const lastPosition = stack[stack.length - 1]
        if (lastPosition.uri === currentPosition.uri && lastPosition.lineNumber === currentPosition.lineNumber) {
            return Promise.resolve()
        } else if (stack.length > 50) {
            stack.shift()
        }
    }
    stack.push(currentPosition)
    console.log('ctags: Jump stack:', stack)

    return context.workspaceState.update('CTAGSC_JUMP_STACK', stack)
}

function getTag(editor: vscode.TextEditor): string {
    const tag = editor.document.getText(editor.selection).trim()
    if (!tag) {
        const range = editor.document.getWordRangeAtPosition(editor.selection.active)
        if (range) {
            return editor.document.getText(range)
        }
    }
    return tag
}

/**
 * tags涓病鏈夎鍙凤紝鍒欐牴鎹€変腑鐨刾attern鏉ユ煡璇㈠叿浣撶殑琛屽彿
 */
async function getLineNumberPattern(
    entry: CTagEntry,
    canceller: vscode.CancellationToken | undefined
): Promise<vscode.Selection[]> {
    let matchWhole = false
    let pattern = entry.address.pattern!
    if (pattern.startsWith('^')) {
        pattern = pattern.substring(1, pattern.length)
    } else {
        console.error(`ctags: Unsupported pattern ${pattern}`)
        return []
    }

    if (pattern.endsWith('$')) {
        pattern = pattern.substring(0, pattern.length - 1)
        matchWhole = true
    }

    let lineNumber = 0
    let charPos = 0
    const foundLines: number[] = []
    const foundCharPos: number[] = []

    await new Promise<void>((resolve) => {
        const rl = readline.createInterface({
            input: fs.createReadStream(entry.file),
            crlfDelay: Infinity
        })
        rl.on('line', (line: string) => {
            lineNumber += 1
            if ((matchWhole && line === pattern) || line.startsWith(pattern)) {
                charPos = Math.max(line.indexOf(entry.name), 0)
                console.log(`ctags: Found '${pattern}' at ${lineNumber}:${charPos}`)
                foundLines.push(lineNumber)
                foundCharPos.push(charPos)
            } else if (canceller && canceller.isCancellationRequested) {
                console.log('ctags: Cancelled pattern searching')
                rl.close()
            }
        })
        rl.on('close', resolve)
    })

    const selections: vscode.Selection[] = []
    if (foundLines.length === 0) {
        console.log('ctags: Error: foundLines.length === 0')
        vscode.window.showInformationMessage(`ctags: No match found for '${pattern}'`)
    } else {
        foundLines.forEach((line, index) => {
            console.log(`c: Found '${pattern}' at ${line}:${foundCharPos[index]}`)
            selections.push(new vscode.Selection(line - 1, foundCharPos[index], line - 1, foundCharPos[index]))
        })
        console.log(`c: getLineNumberPattern selections : `, selections)
    }

    return selections
}

/**
 * 鑾峰彇鏂囦欢琛屽彿
 */
function getFileLineNumber(
    document: vscode.TextDocument,
    sel: vscode.Selection
): Promise<vscode.Selection[] | undefined> {
    const selections: vscode.Selection[] = []
    let pos = sel.end.translate(0, 1)
    let range = document.getWordRangeAtPosition(pos)
    if (range) {
        let text = document.getText(range)
        if (text.match(/[0-9]+/)) {
            const lineNumber = Math.max(0, parseInt(text, 10) - 1)
            let charPos = 0

            pos = range.end.translate(0, 1)
            range = document.getWordRangeAtPosition(pos)
            if (range) {
                text = document.getText(range)
                if (text.match(/[0-9]+/)) {
                    charPos = Math.max(0, parseInt(text) - 1)
                }
            }
            console.log(`ctags: Resolved file position to line ${lineNumber + 1}, char ${charPos + 1}`)
            selections.push(new vscode.Selection(lineNumber, charPos, lineNumber, charPos))
            return Promise.resolve(selections)
        }
    }
    return Promise.resolve(undefined)
}

/**
 * 鑾峰彇鏉＄洰鐨勮鍙?
 */
async function getLineNumber(
    entry: CTagEntry,
    document: vscode.TextDocument | null,
    sel: vscode.Selection, canceller?: vscode.CancellationToken
): Promise<vscode.Selection[]> {
    if (entry.address.lineNumber === 0) {
        return getLineNumberPattern(entry, canceller)
    } else if (entry.kind === 'F' && document) {
        return getFileLineNumber(document, sel).then(r => r || [])
    }

    const lineNumber = Math.max(0, entry.address.lineNumber - 1)
    return Promise.resolve([new vscode.Selection(lineNumber, 0, lineNumber, 0)])
}

/**
 * 鎵撳紑骞舵樉绀烘寚瀹氱殑鏂囨。鍜岄€夋嫨
 */
async function openAndReveal(
    context: vscode.ExtensionContext,
    editor: vscode.TextEditor | undefined,
    document: vscode.Uri | string,
    sel: vscode.Selection,
    doSaveState?: boolean
): Promise<vscode.TextEditor> {
    if (doSaveState) {
        return saveState(context, editor)
            .then(() => openAndReveal(context, editor, document, sel))
    }
    return vscode.workspace.openTextDocument(document as vscode.Uri)
        .then(doc => {
            const showOptions: vscode.TextDocumentShowOptions = {
                viewColumn: editor ? editor.viewColumn : vscode.ViewColumn.One,
                preview: vscode.workspace.getConfiguration('ctagsc').get('openAsPreview'),
                selection: sel
            }
            return vscode.window.showTextDocument(doc, showOptions)
        })
}

/**
 * 鏄剧ずCTags鏉＄洰, CTRL+T
 */
async function revealCTags(
    context: vscode.ExtensionContext,
    editor: vscode.TextEditor | undefined,
    entry: CTagEntry
): Promise<vscode.TextEditor | undefined> {
    if (!entry) {
        return
    }

    const document = editor ? editor.document : null
    const triggeredSel = editor ? editor.selection : null

    return getLineNumber(entry, document, triggeredSel as vscode.Selection)
        .then(selections => {
            const options: vscode.QuickPickItem[] = []
            if (Array.isArray(selections)) {
                selections.forEach(sel => {
                    options.push({ label: `Go to ${entry.file}:${sel.start.line + 1}` })
                })
            }

            console.log('options, ', options)
            if (options.length === 1) {
                return openAndReveal(context, editor, entry.file, selections[0], true)
            } else if (options.length > 1) {
                return vscode.window.showQuickPick(options)
                    .then(option => {
                        if (option) {
                            console.log(`You selected: ${option.label}`)
                            return openAndReveal(context, editor, entry.file, selections[options.indexOf(option)], true)
                        } else {
                            console.log('You cancelled the quick pick')
                        }
                    })
            }
        })
}



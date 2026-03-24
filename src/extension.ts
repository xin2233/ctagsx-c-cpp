import * as ctagz from 'ctagz'
import * as lineReader from 'line-reader'
import * as path from 'path'
import Bluebird = require('bluebird')
import * as vscode from 'vscode'
import * as child_process from 'child_process'

const eachLine = Bluebird.promisify(lineReader.eachLine) as (file: string, cb: (line: string) => boolean | void) => Bluebird<void>

interface JumpPosition {
    uri: string
    lineNumber: number
    charPos: number
}

interface CTagEntry {
    file: string
    name: string
    tagKind?: string
    kind?: string
    description?: string
    label?: string
    detail?: string
    address: {
        pattern?: string
        lineNumber: number
    }
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

/**
 * 重新生成 ctags
 */
function doGenerate(): Bluebird<string> {
    const config = vscode.workspace.getConfiguration('ctagsc')
    const command = config.get<string>('generateCTagsCommand')
    if (vscode.workspace.workspaceFolders) {
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/')
        console.log(`Running ctagsc command: ${command}`)
        console.log(`workspacePath pwd :  ${workspacePath}`)
        return new Bluebird<string>((resolve, reject) => {
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
        return Bluebird.reject('未打开任何工作区文件夹')
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

function findCTagsFromPrompt(context: vscode.ExtensionContext): Thenable<void> {
    const options: vscode.InputBoxOptions = {
        prompt: 'Enter a tag to search for'
    }
    return vscode.window.showInputBox(options)
        .then(tag => {
            if (!tag) {
                return
            }
            return findCTags(context, tag)
        })
}

/**
 * Find ctags for a tag in the current document, CTRL+T
 */
function findCTagsInDocument(context: vscode.ExtensionContext): void {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
        console.log('ctags: Cannot search - no active editor (file too large? https://github.com/Microsoft/vscode/issues/3147)')
        return
    }

    const tag = getTag(editor)
    if (!tag) {
        return
    }

    findCTags(context, tag)
}

/**
 * Find ctags for a tag, CTRL+T
 */
function findCTags(context: vscode.ExtensionContext, tag: string): void {
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

    ctagz.findCTagsBSearch(searchPath, tag)
        .then((result: any) => {
            const options: CTagEntry[] = result.results.map((t: CTagEntry) => {
                if (!path.isAbsolute(t.file)) {
                    t.file = path.join(path.dirname(result.tagsFile), t.file)
                }
                t.tagKind = t.kind
                t.description = t.tagKind || ''
                t.label = t.file
                t.detail = t.address.pattern || `Line ${t.address.lineNumber}`
                console.log(`tag :`, t)
                delete t.kind // #20 -> avoid conflict with QuickPickItem
                return t
            })

            if (!options.length) {
                if (!result.tagsFile) {
                    return vscode.window.showWarningMessage(`ctags: No tags file found`)
                }
                return vscode.window.showInformationMessage(`ctags: No tags found for ${tag}`)
            } else if (options.length === 1) {
                return revealCTags(context, editor, options[0])
            } else {
                return vscode.window.showQuickPick(options as any)
                    .then((opt: any) => revealCTags(context, editor, opt))
            }
        })
        .catch((err: any) => {
            console.log(err.stack)
            vscode.window.showErrorMessage(`ctags: Search failed: ${err}`)
        })
}

/**
 * 提供定义函数
 */
function provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    canceller: vscode.CancellationToken
): Bluebird<vscode.Location[]> {
    if (document.isUntitled || document.uri.scheme !== 'file') {
        console.log('ctags: Cannot provide definitions for untitled (unsaved) and/or non-local (non file://) documents')
        return Bluebird.reject(new Error('untitled or non-local document'))
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
            return Bluebird.reject(new Error('no word range'))
        }
        tag = document.getText(range)
        if (!tag) {
            console.log('ctags: Cannot provide definition with an empty tag')
            return Bluebird.reject(new Error('empty tag'))
        }
    }

    return ctagz.findCTagsBSearch(document.fileName, tag)
        .then((result: any) => {
            const options: CTagEntry[] = result.results.map((t: CTagEntry) => {
                if (!path.isAbsolute(t.file)) {
                    t.file = path.join(path.dirname(result.tagsFile), t.file)
                }
                t.tagKind = t.kind
                delete t.kind
                return t
            })

            const results: vscode.Location[] = []
            return Bluebird.each(options, (item: CTagEntry) => {
                if (canceller.isCancellationRequested) {
                    return
                }
                return getLineNumber(item, document, range as vscode.Selection, canceller)
                    .then((selections: vscode.Selection[]) => {
                        if (Array.isArray(selections)) {
                            selections.forEach(sel => {
                                console.log(`provideDefinitio - sel:\n`, sel)
                                results.push(new vscode.Location(vscode.Uri.file(item.file), sel.start))
                            })
                        }
                    })
            }).then(() => results)
        })
        .catch((err: any) => {
            console.log(err.stack)
        })
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
 * 保存当前编辑器的位置
 */
function saveState(context: vscode.ExtensionContext, editor: vscode.TextEditor | undefined): Thenable<void> {
    if (!editor) {
        return Bluebird.resolve()
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
            return Bluebird.resolve()
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
 * tags中没有行号，则根据选中的pattern来查询具体的行号
 */
async function getLineNumberPattern(entry: CTagEntry, canceller: vscode.CancellationToken | undefined): Promise<vscode.Selection[]> {
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

    await eachLine(entry.file, (line: string) => {
        lineNumber += 1
        if ((matchWhole && line === pattern) || line.startsWith(pattern)) {
            charPos = Math.max(line.indexOf(entry.name), 0)
            console.log(`ctags: Found '${pattern}' at ${lineNumber}:${charPos}`)
            foundLines.push(lineNumber)
            foundCharPos.push(charPos)
        } else if (canceller && canceller.isCancellationRequested) {
            console.log('ctags: Cancelled pattern searching')
            return false
        }
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
 * 获取文件行号
 */
function getFileLineNumber(document: vscode.TextDocument, sel: vscode.Selection): Bluebird<vscode.Selection[] | undefined> {
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
            return Bluebird.resolve(selections)
        }
    }
    return Bluebird.resolve(undefined)
}

/**
 * 获取条目的行号
 */
function getLineNumber(
    entry: CTagEntry,
    document: vscode.TextDocument | null,
    sel: vscode.Selection,
    canceller?: vscode.CancellationToken
): Promise<vscode.Selection[]> {
    if (entry.address.lineNumber === 0) {
        return getLineNumberPattern(entry, canceller)
    } else if (entry.tagKind === 'F' && document) {
        return getFileLineNumber(document, sel).then(r => r || [])
    }

    const lineNumber = Math.max(0, entry.address.lineNumber - 1)
    return Bluebird.resolve([new vscode.Selection(lineNumber, 0, lineNumber, 0)])
}

/**
 * 打开并显示指定的文档和选择
 */
function openAndReveal(
    context: vscode.ExtensionContext,
    editor: vscode.TextEditor | undefined,
    document: vscode.Uri | string,
    sel: vscode.Selection,
    doSaveState?: boolean
): Thenable<vscode.TextEditor> {
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
 * 显示CTags条目, CTRL+T
 */
function revealCTags(
    context: vscode.ExtensionContext,
    editor: vscode.TextEditor | undefined,
    entry: CTagEntry
): Thenable<vscode.TextEditor | undefined> | undefined {
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

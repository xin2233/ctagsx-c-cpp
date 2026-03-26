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
async function findCTags(context: vscode.ExtensionContext, tag: string): Promise<void> {
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
 * Provides the definition locations for a symbol at the given position in a VSCode document.
 *
 * This function attempts to resolve the symbol (tag) at the specified position, using either the current selection
 * or the word under the cursor. It then searches for matching tags using ctags, and maps the results to
 * `vscode.Location` objects, which can be used by VSCode to navigate to the symbol's definition(s).
 *
 * If the document is untitled or not a local file, or if no valid tag can be determined, the function rejects with an error.
 * If the search is cancelled via the provided `CancellationToken`, the function returns early with any results found so far.
 *
 * @param document - The VSCode text document in which to provide definitions.
 * @param position - The position in the document where the definition is requested.
 * @param canceller - A cancellation token that can be used to cancel the operation.
 * @returns A promise that resolves to an array of `vscode.Location` objects representing the definition locations.
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
        const result = await findCTagsBSearch(document.fileName, tag)
        const options: CTagEntry[] = result.results.map(entry => resolveCTagEntry(entry, result.tagsFile))

        const results: vscode.Location[] = []
        for (const item of options) {
            if (canceller.isCancellationRequested) {
                break
            }
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
 * Saves the current cursor position (jump position) of the active editor into a stack
 * stored in the extension's workspace state. This stack is used to track navigation history.
 *
 * - If the editor is undefined, the function resolves immediately.
 * - If the current position matches the last saved position, it does not add a duplicate.
 * - Maintains a maximum stack size of 50 by removing the oldest entry when necessary.
 * - Updates the 'CTAGSC_JUMP_STACK' key in the workspace state with the new stack.
 *
 * @param context The extension context providing access to workspace state.
 * @param editor The active text editor whose position should be saved, or undefined.
 * @returns A promise that resolves when the state has been updated.
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
 * Searches for lines in a file that match a given pattern from a CTagEntry and returns their positions as VSCode selections.
 *
 * The function reads the file line by line, looking for lines that match the specified pattern. If the pattern starts with '^', it is treated as a line start anchor.
 * If the pattern ends with '$', it is treated as a line end anchor, and the match must be exact for the whole line.
 * For each matching line, the function determines the character position of the entry name and creates a `vscode.Selection` at that position.
 * If no matches are found, an information message is shown to the user.
 * The search can be cancelled using the provided cancellation token.
 *
 * @param entry - The CTagEntry containing the file path, pattern, and symbol name to search for.
 * @param canceller - An optional VSCode cancellation token to allow aborting the search.
 * @returns A promise that resolves to an array of `vscode.Selection` objects representing the positions of matches in the file.
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
 * Attempts to resolve a file position (line and character) from the text following the given selection.
 * 
 * This function looks for two consecutive numbers after the end of the selection:
 * - The first number is interpreted as the line number (1-based, converted to 0-based).
 * - The second number, if present, is interpreted as the character position (1-based, converted to 0-based).
 * 
 * If both numbers are found, returns a `vscode.Selection` at the resolved position.
 * If not, returns `undefined`.
 * 
 * @param document - The active text document in which to search for the numbers.
 * @param sel - The current selection whose end position is used as the starting point for searching.
 * @returns A promise resolving to an array of `vscode.Selection` with the resolved position, or `undefined` if not found.
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
 * Retrieves the selection(s) corresponding to the line number of a given tag entry.
 *
 * If the entry's line number is zero, attempts to determine the line number using a pattern-based approach.
 * If the entry represents a function ('F') and a document is provided, attempts to determine the line number within the file.
 * Otherwise, returns a selection at the specified line number (adjusted to zero-based indexing).
 *
 * @param entry - The tag entry containing address and kind information.
 * @param document - The VSCode text document, if available.
 * @param sel - The current selection in the document.
 * @param canceller - Optional cancellation token to support cancellation.
 * @returns A promise resolving to an array of VSCode selections corresponding to the determined line number(s).
 */
async function getLineNumber(
    entry: CTagEntry,
    document: vscode.TextDocument | null,
    sel: vscode.Selection, canceller?: vscode.CancellationToken
): Promise<vscode.Selection[]> {
    if (entry.address.lineNumber === 0) {
        // 表示 ctags 条目没有直接提供行号
        return getLineNumberPattern(entry, canceller)
    } else if (entry.kind === 'F' && document) {
        // 如果条目类型是函数（entry.kind === 'F'）且提供了文档对象
        return getFileLineNumber(document, sel).then(r => r || [])
    }
    // 否则，直接使用 ctags 提供的行号（调整为零基索引）
    const lineNumber = Math.max(0, entry.address.lineNumber - 1)
    return Promise.resolve([new vscode.Selection(lineNumber, 0, lineNumber, 0)])
}

/**
 * Opens a text document in the editor and reveals the specified selection.
 * Optionally saves the current editor state before opening the document.
 *
 * @param context - The extension context used for state management.
 * @param editor - The current text editor, or undefined if none is active.
 * @param document - The URI or string path of the document to open.
 * @param sel - The selection to reveal in the opened document.
 * @param doSaveState - If true, saves the current editor state before opening the document.
 * @returns A promise that resolves to the opened and revealed TextEditor.
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
 * Reveals the location(s) of a given CTag entry in the editor.
 *
 * If multiple locations are found, presents a QuickPick for the user to select which location to navigate to.
 * If only one location is found, navigates directly to that location.
 *
 * @param context - The extension context used for resource management.
 * @param editor - The current active text editor, or undefined if none is active.
 * @param entry - The CTag entry to reveal in the editor.
 * @returns A promise that resolves to the updated TextEditor if navigation occurs, or undefined otherwise.
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



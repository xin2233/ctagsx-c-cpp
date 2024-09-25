const ctagz = require('ctagz')
const lineReader = require('line-reader')
const path = require('path')
const Promise = require('bluebird')
const vscode = require('vscode')
const eachLine = Promise.promisify(lineReader.eachLine)

// Called when the plugin is first activated
function activate(context) {
    console.log('ctagsx is live')

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

    if (!vscode.workspace.getConfiguration('ctagsx').get('disableDefinitionProvider')) {
        disposable = vscode.languages.registerDefinitionProvider({ pattern: '**/*' }, { provideDefinition })
        context.subscriptions.push(disposable)
    }
}
exports.activate = activate

// Called when the plugin is deactivated
function deactivate() {
    console.log('ctagsx is tombstoned')
}
exports.deactivate = deactivate

function createTerminal() {
    vscode.window.createTerminal().show()
}

function findCTagsFromPrompt(context) {
    const options = {
        'prompt': 'Enter a tag to search for'
    }
    // TODO: Provide completion (jtanx/ctagz#2)
    return vscode.window.showInputBox(options).then(tag => {
        if (!tag) {
            return
        }
        return findCTags(context, tag)
    })
}

function findCTagsInDocument(context) {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
        console.log('ctagsx-c-cpp: Cannot search - no active editor (file too large? https://github.com/Microsoft/vscode/issues/3147)')
        return
    }

    const tag = getTag(editor)
    if (!tag) {
        return
    }

    return findCTags(context, tag)
}

function findCTags(context, tag) {
    const editor = vscode.window.activeTextEditor
    let searchPath = vscode.workspace.rootPath

    if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
        searchPath = editor.document.fileName
    }

    if (!searchPath) {
        console.log('ctagsx-c-cpp: Could not get a path to search for tags file')
        if (editor) {
            console.log('ctagsx-c-cpp: Document is untitled? ', editor.document.isUntitled)
            console.log('ctagsx-c-cpp: Document URI:', editor.document.uri.toString())
        } else {
            console.log('ctagsx-c-cpp: Active text editor is undefined')
        }
        console.log('ctagsx-c-cpp: Workspace root: ', vscode.workspace.rootPath)
        return vscode.window.showWarningMessage(`ctagsx-c-cpp: No searchable path (no workspace folder open?)`)
    }

    ctagz.findCTagsBSearch(searchPath, tag)
        .then(result => {
            const options = result.results.map(tag => {
                if (!path.isAbsolute(tag.file)) {
                    tag.file = path.join(path.dirname(result.tagsFile), tag.file)
                }
                tag.tagKind = tag.kind
                tag.description = tag.tagKind || ''
                tag.label = tag.file
                tag.detail = tag.address.pattern || `Line ${tag.address.lineNumber}`
                console.log(`tag.detail "${tag.detail}" in path "${searchPath}"...`);
                console.log(`tag.label "${tag.detail}" in path "${searchPath}"...`);
                console.log(`tag.address.lineNumber "${tag.address.lineNumber}" in path "${searchPath}"...`);
                console.log(`tag.tagKind "${tag.tagKind}" in path "${searchPath}"...`);
                console.log(`tag.address.pattern  "${tag.address.pattern }" in path "${searchPath}"...`);
                delete tag.kind // #20 -> avoid conflict with QuickPickItem
                return tag
            })

            if (!options.length) {
                if (!result.tagsFile) {
                    return vscode.window.showWarningMessage(`ctagsx-c-cpp: No tags file found`)
                }
                return vscode.window.showInformationMessage(`ctagsx-c-cpp: No tags found for ${tag}`)
            } else if (options.length === 1) {
                return revealCTags(context, editor, options[0])
            } else {
                return vscode.window.showQuickPick(options).then(opt => {
                    return revealCTags(context, editor, opt)
                })
            }
        })
        .catch(err => {
            console.log(err.stack)
            vscode.window.showErrorMessage(`ctagsx-c-cpp: Search failed: ${err}`)
        })
}

function provideDefinition(document, position, canceller) {
    if (document.isUntitled || document.uri.scheme !== 'file') {
        console.log('ctagsx-c-cpp: Cannot provide definitions for untitled (unsaved) and/or non-local (non file://) documents')
        return Promise.reject()
    }

    let tag, range
    const editor = vscode.window.activeTextEditor
    if (editor && editor.document == document && position.isEqual(editor.selection.active)) {
        range = editor.selection
        tag = editor.document.getText(editor.selection).trim()
    }

    if (!tag) {
        range = document.getWordRangeAtPosition(position)
        if (!range) {
            console.log('ctagsx-c-cpp: Cannot provide definition without a valid tag (word range)')
            return Promise.reject()
        }
        tag = document.getText(range)
        if (!tag) {
            console.log('ctagsx-c-cpp: Cannot provide definition with an empty tag')
            return Promise.reject()
        }
    }

    return ctagz.findCTagsBSearch(document.fileName, tag)
        .then(result => {
            const options = result.results.map(tag => {
                if (!path.isAbsolute(tag.file)) {
                    tag.file = path.join(path.dirname(result.tagsFile), tag.file)
                }
                tag.tagKind = tag.kind
                delete tag.kind
                return tag
            })

            const results = []
            return Promise.each(options, item => {
                if (canceller.isCancellationRequested) {
                    return
                }
                return getLineNumber(item, document, range, canceller).then(sel => {
                    if (sel) {
                        results.push(new vscode.Location(vscode.Uri.file(item.file), sel.start))
                    }
                })
            }).then(() => {
                return results
            })
        })
        .catch(err => {
            console.log(err.stack)
        })
}

function jumpBack(context) {
    const stack = context.workspaceState.get('CTAGSX_JUMP_STACK', [])
    if (stack.length > 0) {
        const position = stack.pop()
        return context.workspaceState.update('CTAGSX_JUMP_STACK', stack).then(() => {
            const uri = vscode.Uri.parse(position.uri)
            const sel = new vscode.Selection(position.lineNumber, position.charPos, position.lineNumber, position.charPos)
            return openAndReveal(context, vscode.window.activeTextEditor, uri, sel)
        })
    }
}

function clearJumpStack(context) {
    return context.workspaceState.update('CTAGSX_JUMP_STACK', [])
}

function saveState(context, editor) {
    if (!editor) {
        // Can happen on manual entry with no editor open
        return Promise.resolve()
    }
    const currentPosition = {
        uri: editor.document.uri.toString(),
        lineNumber: editor.selection.active.line,
        charPos: editor.selection.active.character
    }

    const stack = context.workspaceState.get('CTAGSX_JUMP_STACK', [])
    if (stack.length > 0) {
        const lastPosition = stack[stack.length - 1]
        // As long as the jump position was roughly the same line, don't save to the stack
        if (lastPosition.uri === currentPosition.uri && lastPosition.lineNumber === currentPosition.lineNumber) {
            return Promise.resolve()
        } else if (stack.length > 50) {
            stack.shift()
        }
    }
    stack.push(currentPosition)
    console.log('ctagsx-c-cpp: Jump stack:', stack)

    return context.workspaceState.update('CTAGSX_JUMP_STACK', stack)
}

function getTag(editor) {
    const tag = editor.document.getText(editor.selection).trim()
    if (!tag) {
        const range = editor.document.getWordRangeAtPosition(editor.selection.active)
        if (range) {
            return editor.document.getText(range)
        }
    }
    return tag
}

function getLineNumberPattern(entry, canceller) {
    let matchWhole = false
    let pattern = entry.address.pattern
    if (pattern.startsWith("^")) {
        pattern = pattern.substring(1, pattern.length)
    } else {
        console.error(`ctagsx-c-cpp: Unsupported pattern ${pattern}`)
        return Promise.resolve(0)
    }

    if (pattern.endsWith("$")) {
        pattern = pattern.substring(0, pattern.length - 1)
        matchWhole = true
    }

    let found = 0; // 如果找到了，就 = true
    let lineNumber = 0; // 遍历的行数
    let charPos = 0;
    const found_lines = []; // 存放找到的行
    const foundCharPos = []; // 存放找到的字符位置
    return eachLine(entry.file, line => {
        lineNumber += 1;
        if ((matchWhole && line === pattern) || line.startsWith(pattern)) {
            found = true;
            charPos = Math.max(line.indexOf(entry.name), 0);
            console.log(`ctagsx-c-cpp: Found '${pattern}' at ${lineNumber}:${charPos}`);
            // return false  // 遍历所有行了，找到了，也不return
            found_lines.push(lineNumber);  // 存放找到的行
            foundCharPos.push(charPos);  // 存放找到的字符位置
        } else if (canceller && canceller.isCancellationRequested) {
            console.log('ctagsx-c-cpp: Cancelled pattern searching')
            return false
        }
    })
        .then(() => {
            // 找到了
            if (found) {
                // 判断存放的行数是否为0
                if (found_lines.length === 0) {
                    // 此时代码有是逻辑错误
                    console.log('ctagsx-c-cpp: Error: found_lines.length === 0');
                    // 如果为0,则显示一个提示框，告诉用户没有找到
                    vscode.window.showInformationMessage(`ctagsx-c-cpp: No match found for '${pattern}'`);
                }
                // 判断存放的行数是否大于1
                if (found_lines.length > 1) {
                    // 如果大于1,则显示一个选择框，让用户选择要跳转的行
                    // 创建一个对象，可以传递给 showQuickPick 函数当参数，用于显示一个选择框
                    const quickPickItems = found_lines.map((line, index) => ({
                        label: `${line}`,
                        description: `${pattern} Line ${line} at ${foundCharPos[index]}`,
                        line: line,
                        charPos: foundCharPos[index]
                    }))
                    vscode.window.showQuickPick(quickPickItems).then(selection => {
                        if (selection) {
                            // 打印 linnumber 和 charPos
                            console.log(`ctagsx-c-cpp: Selected line ${selection.line} at ${selection.charPos}`);
                            console.log(`ctagsx-c-cpp: selection ${selection}`);
                            const index = found_lines.indexOf(selection.label);
                            console.log(`User selected option ${index}`);

                            lineNumber = selection.line;
                            charPos = selection.charPos;
                            return new vscode.Selection(lineNumber - 1, charPos, lineNumber - 1, charPos);
                        }
                    }).catch (err => {
                        // 如果出现错误，则显示错误信息
                        console.log(err.stack);
                        vscode.window.showErrorMessage(`ctagsx: Search failed: ${err.message || err}`);
                    });
                }
                // 如果存放的行数等于1
                if (found_lines.length === 1) {
                    // 直接return
                    lineNumber = found_lines[0];
                    charPos = foundCharPos[0];
                    return new vscode.Selection(lineNumber - 1, charPos, lineNumber - 1, charPos)
                }
            }
        })
}

/**
 * Attempts to infer the line number/character position for a file
 * navigation based on the selection/range that triggered this search.
 * @param {*} document Document that triggered this call
 * @param {*} sel Selection or range that triggered this call
 */
function getFileLineNumber(document, sel) {
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
            console.log(`ctagsx-c-cpp: Resolved file position to line ${lineNumber + 1}, char ${charPos + 1}`)
            return Promise.resolve(new vscode.Selection(lineNumber, charPos, lineNumber, charPos))
        }
    }
    return Promise.resolve()
}

/**
 * Finds the line number (selection) within the document
 * @param {*} entry The tag entry
 * @param {*} document The document that triggered this call (optional)
 * @param {*} sel The selection or range that triggered this call (optional)
 * @param {*} canceller The cancellation token to cancel this action
 * @returns A promise resolving to the selection within the document, or undefined if not found
 */
function getLineNumber(entry, document, sel, canceller) {
    if (entry.address.lineNumber === 0) {
        return getLineNumberPattern(entry, canceller)
    } else if (entry.tagKind === 'F') {
        if (document) {
            return getFileLineNumber(document, sel)
        }
    }

    const lineNumber = Math.max(0, entry.address.lineNumber - 1)
    return Promise.resolve(new vscode.Selection(lineNumber, 0, lineNumber, 0))
}

function openAndReveal(context, editor, document, sel, doSaveState) {
    if (doSaveState) {
        return saveState(context, editor).then(() => openAndReveal(context, editor, document, sel))
    }
    return vscode.workspace.openTextDocument(document).then(doc => {
        const showOptions = {
            viewColumn: editor ? editor.viewColumn : vscode.ViewColumn.One,
            preview: vscode.workspace.getConfiguration('ctagsx').get('openAsPreview'),
            selection: sel
        }
        return vscode.window.showTextDocument(doc, showOptions)
    })
}

function revealCTags(context, editor, entry) {
    if (!entry) {
        return
    }

    const document = editor ? editor.document : null
    const triggeredSel = editor ? editor.selection : null
    return getLineNumber(entry, document, triggeredSel).then(sel => {
        return openAndReveal(context, editor, entry.file, sel, true)
    })
}
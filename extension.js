const ctagz = require('ctagz')
const lineReader = require('line-reader')
const path = require('path')
const Promise = require('bluebird')
const vscode = require('vscode')
const eachLine = Promise.promisify(lineReader.eachLine)

// Called when the plugin is first activated
function activate(context) {
    console.log('ctagsx is live')

    // 注册命令，用于在当前文档中查找CTags
    let disposable = vscode.commands.registerCommand('extension.findCTags', () => findCTagsInDocument(context))
    // 将命令添加到插件上下文中
    context.subscriptions.push(disposable)

    // 注册命令，用于从提示框中查找CTags
    disposable = vscode.commands.registerCommand('extension.findCTagsPrompt', () => findCTagsFromPrompt(context))
    // 将命令添加到插件上下文中
    context.subscriptions.push(disposable)

    disposable = vscode.commands.registerCommand('extension.ctagsJumpBack', () => jumpBack(context))
    context.subscriptions.push(disposable)

    disposable = vscode.commands.registerCommand('extension.ctagsClearJumpStack', () => clearJumpStack(context))
    context.subscriptions.push(disposable)

    disposable = vscode.commands.registerCommand('extension.createTerminal', createTerminal)
    context.subscriptions.push(disposable)

    // 检查是否禁用了定义提供程序
    if (!vscode.workspace.getConfiguration('ctagsx').get('disableDefinitionProvider')) {
        // 注册定义提供程序，匹配所有文件
        disposable = vscode.languages.registerDefinitionProvider({ pattern: '**/*' }, { provideDefinition });
        // 将定义提供程序添加到上下文的订阅中，以便在扩展被禁用时可以清理
        context.subscriptions.push(disposable);
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
                console.log(`tag :`, tag)
                // console.log(`tag.detail "${tag.detail}" in path "${searchPath}"...`);
                // console.log(`tag.label "${tag.detail}" in path "${searchPath}"...`);
                // console.log(`tag.address.lineNumber "${tag.address.lineNumber}" in path "${searchPath}"...`);
                // console.log(`tag.tagKind "${tag.tagKind}" in path "${searchPath}"...`);
                // console.log(`tag.address.pattern  "${tag.address.pattern}" in path "${searchPath}"...`);
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

/**
 * 提供定义函数
 * @param {vscode.TextDocument} document - 当前文档
 * @param {vscode.Position} position - 光标位置
 * @param {vscode.CancellationToken} canceller - 取消令牌
 * @returns {Promise<vscode.Location[]>} - 定义位置列表
 */
function provideDefinition(document, position, canceller) {
    // 检查文档是否未保存或非本地文档
    if (document.isUntitled || document.uri.scheme !== 'file') {
        console.log('ctagsx-c-cpp: Cannot provide definitions for untitled (unsaved) and/or non-local (non file://) documents')
        return Promise.reject()
    }

    let tag, range
    const editor = vscode.window.activeTextEditor
    // 如果当前编辑器是活动编辑器且光标位置与选择位置相同
    if (editor && editor.document == document && position.isEqual(editor.selection.active)) {
        range = editor.selection
        // 获取当前选择的内容作为标签
        tag = editor.document.getText(editor.selection).trim()
    }

    // 如果没有标签
    if (!tag) {
        // 获取光标所在位置的单词范围
        range = document.getWordRangeAtPosition(position)
        // 如果没有获取到单词范围
        if (!range) {
            console.log('ctagsx-c-cpp: Cannot provide definition without a valid tag (word range)')
            return Promise.reject()
        }
        // 获取光标所在位置的单词作为标签
        tag = document.getText(range)
        // 如果标签为空
        if (!tag) {
            console.log('ctagsx-c-cpp: Cannot provide definition with an empty tag')
            return Promise.reject()
        }
    }

    // 使用ctagz模块查找标签
    return ctagz.findCTagsBSearch(document.fileName, tag)
        .then(result => {
            // 将结果中的标签转换为vscode.Location对象
            const options = result.results.map(tag => {
                // 如果标签文件路径不是绝对路径，则转换为绝对路径
                if (!path.isAbsolute(tag.file)) {
                    tag.file = path.join(path.dirname(result.tagsFile), tag.file)
                }
                tag.tagKind = tag.kind
                delete tag.kind
                return tag
            })

            const results = []
            // 遍历每个标签
            return Promise.each(options, item => {
                // 如果取消请求被触发
                if (canceller.isCancellationRequested) {
                    return
                }
                // 获取标签在文档中的位置
                return getLineNumber(item, document, range, canceller)
                    .then(sel => {
                        // 如果获取到了位置
                        if (sel) {
                            // 将位置添加到结果中
                            results.push(new vscode.Location(vscode.Uri.file(item.file), sel.start))
                        }
                    })
            }).then(() => {
                // 返回结果
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

/**
 * 获取标签在文档中的位置
 * @param {*} entry 
 * @param {*} canceller 
 * @returns {Promise<vscode.Selection>} - 标签位置
 */
async function getLineNumberPattern(entry, canceller) {
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
    await eachLine(entry.file, line => {
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
            try {
                const selection = await vscode.window.showQuickPick(quickPickItems);
                if (selection) {
                    // 打印 linnumber 和 charPos
                    console.log(`ctagsx-c-cpp: Selected line ${selection.line} at ${selection.charPos}`);
                    console.log(`ctagsx-c-cpp: selection ${selection}`);
                    const index = found_lines.indexOf(selection.label);
                    lineNumber = selection.line;
                    charPos = selection.charPos;
                    console.log(`ctagsx-c-cpp: index ${index} Selected line ${lineNumber} at ${charPos}`);
                    return new vscode.Selection(lineNumber - 1, charPos, lineNumber - 1, charPos);
                }
            } catch (err) {
                // 如果出现错误，则显示错误信息
                console.log(err.stack);
                vscode.window.showErrorMessage(`ctagsx: Search failed: ${err.message || err}`);
            }
        }
        // 如果存放的行数等于1
        if (found_lines.length === 1) {
            // 直接return
            lineNumber = found_lines[0];
            charPos = foundCharPos[0];
            return new vscode.Selection(lineNumber - 1, charPos, lineNumber - 1, charPos)
        }
    }
}


/**
 * 获取文件行号。
 * 
 * @param {Object} document - 当前文档对象。
 * @param {Object} sel - 当前选择对象。
 * 
 * @returns {Promise} - 返回一个Promise对象，表示操作完成。
 */
function getFileLineNumber(document, sel) {
    // 获取当前光标位置
    let pos = sel.end.translate(0, 1)
    // 获取光标位置的单词范围
    let range = document.getWordRangeAtPosition(pos)
    if (range) {
        // 获取光标位置的单词文本
        let text = document.getText(range)
        // 如果文本匹配数字，则获取行号
        if (text.match(/[0-9]+/)) {
            const lineNumber = Math.max(0, parseInt(text, 10) - 1)
            let charPos = 0

            // 获取光标位置的下一个单词范围
            pos = range.end.translate(0, 1)
            range = document.getWordRangeAtPosition(pos)
            if (range) {
                // 获取光标位置的下一个单词文本
                text = document.getText(range)
                // 如果文本匹配数字，则获取字符位置
                if (text.match(/[0-9]+/)) {
                    charPos = Math.max(0, parseInt(text) - 1)
                }
            }
            console.log(`ctagsx-c-cpp: Resolved file position to line ${lineNumber + 1}, char ${charPos + 1}`)
            // 返回行号和字符位置
            return Promise.resolve(new vscode.Selection(lineNumber, charPos, lineNumber, charPos))
        }
    }
    // 如果没有找到行号和字符位置，则返回空Promise
    return Promise.resolve()
}


/**
 * 获取条目的行号。
 * 
 * @param {Object} entry - 要获取行号的CTags条目对象。
 * @param {Object} document - 当前文档对象。
 * @param {Object} sel - 当前选择对象。
 * @param {Object} canceller - 取消器对象。
 * 
 * @returns {Promise} - 返回一个Promise对象，表示操作完成。
 */
function getLineNumber(entry, document, sel, canceller) {
    // 如果条目的行号为0，则使用正则表达式模式获取行号
    if (entry.address.lineNumber === 0) {
        return getLineNumberPattern(entry, canceller)
    }

    // 如果条目的类型是函数，并且当前文档存在，则获取文件行号
    if (entry.tagKind === 'F') {
        if (document) {
            return getFileLineNumber(document, sel)
        }
    }

    const lineNumber = Math.max(0, entry.address.lineNumber - 1)
    // 最后，返回条目的行号
    return Promise.resolve(new vscode.Selection(lineNumber, 0, lineNumber, 0))
}


/**
 * 打开并显示指定的文档和选择。
 * 
 * @param {Object} context - 插件上下文对象。
 * @param {Object} editor - 当前活动编辑器对象。
 * @param {Object} document - 要打开的文档对象。
 * @param {Object} sel - 要显示的选择对象。
 * @param {boolean} doSaveState - 是否保存当前编辑器的状态。
 * 
 * @returns {Promise} - 返回一个Promise对象，表示操作完成。
 */
function openAndReveal(context, editor, document, sel, doSaveState) {
    // 如果需要保存当前编辑器的状态，则先保存状态
    if (doSaveState) {
        return saveState(context, editor).then(() => openAndReveal(context, editor, document, sel))
    }
    // 打开指定的文档
    return vscode.workspace.openTextDocument(document).then(doc => {
        // 设置显示选项
        const showOptions = {
            viewColumn: editor ? editor.viewColumn : vscode.ViewColumn.One,
            preview: vscode.workspace.getConfiguration('ctagsx').get('openAsPreview'),
            selection: sel
        }
        // 显示文档
        return vscode.window.showTextDocument(doc, showOptions)
    })
}

/**
 * 显示CTags条目。
 * 
 * @param {Object} context - 插件上下文对象。
 * @param {Object} editor - 当前活动编辑器对象。
 * @param {Object} entry - 要显示的CTags条目对象。
 * 
 * @returns {Promise} - 返回一个Promise对象，表示操作完成。
 */
function revealCTags(context, editor, entry) {
    // 如果没有传入条目，则直接返回
    if (!entry) {
        return
    }

    // 获取当前文档和选择
    const document = editor ? editor.document : null
    const triggeredSel = editor ? editor.selection : null

    // 获取条目的行号
    return getLineNumber(entry, document, triggeredSel)
        .then(sel => {
            // 打开并显示条目的文档和选择
            return openAndReveal(context, editor, entry.file, sel, true)
        })
}

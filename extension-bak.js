const ctagz = require('ctagz') // 引入用于查找ctags的库
const lineReader = require('line-reader') // 引入读取文件行的库
const path = require('path') // 引入用于处理文件路径的库
const Promise = require('bluebird') // 引入蓝鸟Promise库，用于异步操作
const vscode = require('vscode') // 引入VS Code API，用于插件开发
const eachLine = Promise.promisify(lineReader.eachLine) // 将line-reader的eachLine函数转化为Promise版本

// 当插件首次激活时调用的函数
function activate(context) {
    console.log('ctagsx-c-cpp is live') // 插件启动时输出信息

    // 注册命令，在命令面板中可通过'extension.findCTags'调用
    let disposable = vscode.commands.registerCommand('extension.findCTags', () => findCTagsInDocument(context))
    context.subscriptions.push(disposable) // 将命令加入context中，以便插件停用时自动释放资源

    // 注册命令，通过用户输入tag查找ctags
    disposable = vscode.commands.registerCommand('extension.findCTagsPrompt', () => findCTagsFromPrompt(context))
    context.subscriptions.push(disposable)

    // 注册命令，用于跳转到之前的代码位置
    disposable = vscode.commands.registerCommand('extension.ctagsJumpBack', () => jumpBack(context))
    context.subscriptions.push(disposable)

    // 注册命令，用于清空跳转堆栈
    disposable = vscode.commands.registerCommand('extension.ctagsClearJumpStack', () => clearJumpStack(context))
    context.subscriptions.push(disposable)

    // 注册命令，用于创建终端
    disposable = vscode.commands.registerCommand('extension.createTerminal', createTerminal)
    context.subscriptions.push(disposable)

    // 如果用户没有禁用定义提供者，注册提供定义的功能
    if (!vscode.workspace.getConfiguration('ctagsx').get('disableDefinitionProvider')) {
        disposable = vscode.languages.registerDefinitionProvider({ pattern: '**/*' }, { provideDefinition })
        context.subscriptions.push(disposable)
    }
}
exports.activate = activate // 导出activate函数供VS Code调用

// 当插件被停用时调用的函数
function deactivate() {
    console.log('ctagsx is tombstoned') // 插件停用时输出信息
}
exports.deactivate = deactivate // 导出deactivate函数供VS Code调用

// 创建一个新的终端窗口并显示
function createTerminal() {
    vscode.window.createTerminal().show()
}

// 从用户输入中获取tag，并进行查找
function findCTagsFromPrompt(context) {
    const options = {
        'prompt': 'Enter a tag to search for' // 提示用户输入tag
    }
    // TODO: 实现tag的自动补全
    return vscode.window.showInputBox(options).then(tag => {
        if (!tag) {
            return // 如果用户没有输入内容，则直接返回
        }
        return findCTags(context, tag) // 根据用户输入的tag进行查找
    })
}

// 从当前打开的文档中获取选中的tag，并进行查找
function findCTagsInDocument(context) {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
        console.log('ctagsx: Cannot search - no active editor') // 如果没有打开的编辑器，输出错误信息
        return
    }

    const tag = getTag(editor) // 获取当前选中的tag
    if (!tag) {
        return // 如果没有选中的tag，直接返回
    }

    return findCTags(context, tag) // 查找选中的tag
}

// 查找ctags文件并显示匹配结果
function findCTags(context, tag) {
    const editor = vscode.window.activeTextEditor
    let searchPath = vscode.workspace.rootPath // 获取工作区的根目录路径

    // 如果编辑器中打开的是一个文件，则使用文件路径作为查找范围
    if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
        searchPath = editor.document.fileName
    }

    if (!searchPath) {
        console.log('ctagsx: Could not get a path to search for tags file') // 如果无法确定搜索路径，输出错误信息
        return vscode.window.showWarningMessage('ctagsx: No searchable path (no workspace folder open?)')
    }

    // 使用ctagz库进行二分查找以查找tag
    ctagz.findCTagsBSearch(searchPath, tag)
        .then(result => {
            const options = result.results.map(tag => {
                if (!path.isAbsolute(tag.file)) {
                    tag.file = path.join(path.dirname(result.tagsFile), tag.file) // 将非绝对路径转换为绝对路径
                }
                tag.tagKind = tag.kind
                tag.description = tag.tagKind || ''
                tag.label = tag.file // 标签显示文件名
                tag.detail = tag.address.pattern || `Line ${tag.address.lineNumber}` // 显示tag的位置或行号
                console.log(`tag.detail "${tag.detail}" in path "${searchPath}"...`);
                console.log(`tag.label "${tag.detail}" in path "${searchPath}"...`);
                console.log(`tag.address.lineNumber "${tag.address.lineNumber}" in path "${searchPath}"...`);
                console.log(`tag.tagKind "${tag.tagKind}" in path "${searchPath}"...`);
                console.log(`tag.address.pattern  "${tag.address.pattern }" in path "${searchPath}"...`);
                delete tag.kind // 删除kind属性避免冲突
                return tag
            })

            // 如果没有找到tag，显示相应的提示信息
            if (!options.length) {
                if (!result.tagsFile) {
                    return vscode.window.showWarningMessage('ctagsx: No tags file found')
                }
                return vscode.window.showInformationMessage(`ctagsx: No tags found for ${tag}`)
            } else if (options.length === 1) {
                return revealCTags(context, editor, options[0]) // 如果只有一个匹配结果，直接跳转到该tag
            } else {
                return vscode.window.showQuickPick(options).then(opt => {
                    return revealCTags(context, editor, opt) // 显示多个匹配结果供用户选择
                })
            }
        })
        .catch(err => {
            console.log(err.stack) // 输出错误堆栈
            vscode.window.showErrorMessage(`ctagsx: Search failed: ${err}`) // 显示错误信息
        })
}

// /**
//  * ver2: 实现当一个文件中有2个相同的tag时，将所有的tag都提供出来，由用户跳转
//  * @param {*} context
//  * @param {*} tag
//  * @returns
//  */
// // 查找ctags文件并显示匹配结果
// function findCTags(context, tag) {
//     const editor = vscode.window.activeTextEditor;
//     let searchPath = vscode.workspace.rootPath;

//     if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
//         searchPath = editor.document.fileName;
//     }

//     if (!searchPath) {
//         console.log('ctagsx: Could not get a path to search for tags file');
//         return vscode.window.showWarningMessage(`ctagsx: No searchable path (no workspace folder open?)`);
//     }

//     return ctagz.findCTagsBSearch(searchPath, tag)
//         .then(result => {
//             console.log(`Searching for tag "${tag}" in path "${searchPath}"...`); // 添加调试信息
//             console.log(`result  "${result}" in path "${searchPath}"...`); // 添加调试信息
//             if (!result.results.length) {
//                 // 没有找到任何匹配的tag，向用户显示消息
//                 return vscode.window.showInformationMessage(`ctagsx: No tags found for "${tag}"`);
//             }

//             const options = result.results.map(tag => {
//                 if (!path.isAbsolute(tag.file)) {
//                     tag.file = path.join(path.dirname(result.tagsFile), tag.file);
//                 }
//                 tag.tagKind = tag.kind;
//                 tag.label = tag.file;
//                 tag.detail = tag.address.pattern || `Line ${tag.address.lineNumber}`;
//                 // console.log(`o111ptions "${options}" in path "${searchPath}"...`); // 添加调试信息
//                 console.log(`tag.detail "${tag.detail}" in path "${searchPath}"...`); // 添加调试信息
//                 console.log(`tag.address.lineNumber "${tag.address.lineNumber}" in path "${searchPath}"...`); // 添加调试信息
//                 return tag;
//             });

//             console.log(`options "${options}" in path "${searchPath}"...`); // 添加调试信息
//             // 如果找到多个匹配的tag，显示给用户选择
//             if (options.length > 1) {
//                 return vscode.window.showQuickPick(options).then(opt => {
//                     return revealCTags(context, editor, opt);
//                 });
//             }

//             // 如果只有一个匹配的tag，直接跳转到该tag
//             return revealCTags(context, editor, options[0]);
//         })
//         .catch(err => {
//             // 捕获异常，显示错误信息
//             console.log(err.stack);
//             vscode.window.showErrorMessage(`ctagsx: Search failed: ${err.message || err}`);
//         });
// }


/**
 * 提供tag定义的实现，用于跳转到定义处
 * @param {*} document
 * @param {*} position
 * @param {*} canceller
 * @returns
 */
function provideDefinition(document, position, canceller) {
    if (document.isUntitled || document.uri.scheme !== 'file') {
        console.log('ctagsx: Cannot provide definitions for untitled (unsaved) and/or non-local documents')
        return Promise.reject()
    }

    let tag, range
    const editor = vscode.window.activeTextEditor
    if (editor && editor.document == document && position.isEqual(editor.selection.active)) {
        range = editor.selection
        tag = editor.document.getText(editor.selection).trim() // 获取用户选中的文本作为tag
    }

    if (!tag) {
        range = document.getWordRangeAtPosition(position) // 如果没有选中文本，获取当前光标所在的词
        if (!range) {
            console.log('ctagsx: Cannot provide definition without a valid tag (word range)')
            return Promise.reject()
        }
        tag = document.getText(range)
        if (!tag) {
            console.log('ctagsx: Cannot provide definition with an empty tag')
            return Promise.reject()
        }
    }

    return ctagz.findCTagsBSearch(document.fileName, tag) // 根据文件名和tag进行查找
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
                        results.push(new vscode.Location(vscode.Uri.file(item.file), sel.start)) // 返回跳转的位置
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

// 跳回之前的位置
function jumpBack(context) {
    const stack = context.workspaceState.get('CTAGSX_JUMP_STACK', [])
    if (stack.length > 0) {
        const position = stack.pop() // 弹出最后一个位置
        return context.workspaceState.update('CTAGSX_JUMP_STACK', stack).then(() => {
            const uri = vscode.Uri.parse(position.uri)
            const sel = new vscode.Selection(position.lineNumber, position.charPos, position.lineNumber, position.charPos)
            return openAndReveal(context, vscode.window.activeTextEditor, uri, sel) // 打开并跳转到该位置
        })
    }
}

// 清空跳转堆栈
function clearJumpStack(context) {
    return context.workspaceState.update('CTAGSX_JUMP_STACK', [])
}

// 保存当前状态，即当前位置
function saveState(context, editor) {
    if (!editor) {
        return Promise.resolve() // 如果没有打开的编辑器，直接返回
    }
    const currentPosition = {
        uri: editor.document.uri.toString(), // 当前文档URI
        lineNumber: editor.selection.active.line, // 当前行号
        charPos: editor.selection.active.character // 当前字符位置
    }

    const stack = context.workspaceState.get('CTAGSX_JUMP_STACK', [])
    if (stack.length > 0) {
        const lastPosition = stack[stack.length - 1]
        if (lastPosition.uri === currentPosition.uri && lastPosition.lineNumber === currentPosition.lineNumber) {
            return Promise.resolve() // 如果位置相同，则不保存
        } else if (stack.length > 50) {
            stack.shift() // 保证堆栈不会超过50个位置
        }
    }
    stack.push(currentPosition) // 将当前位置加入堆栈
    console.log('ctagsx: Jump stack:', stack)

    return context.workspaceState.update('CTAGSX_JUMP_STACK', stack) // 更新堆栈
}

// 获取选中的tag或当前光标处的tag
function getTag(editor) {
    const tag = editor.document.getText(editor.selection).trim() // 获取当前选中文本
    if (!tag) {
        const range = editor.document.getWordRangeAtPosition(editor.selection.active) // 如果没有选中文本，则获取光标所在词
        if (range) {
            return editor.document.getText(range)
        }
    }
    return tag
}

// 使用正则表达式模式查找tag所在行号
function getLineNumberPattern(entry, canceller) {
    let matchWhole = false
    let pattern = entry.address.pattern
    if (pattern.startsWith("^")) {
        pattern = pattern.substring(1); // 去掉正则表达式中的起始符号 ^
        matchWhole = true; // 标记为完全匹配模式
    }

    // 使用正则表达式查找匹配的行
    return eachLine(entry.file, (line, lineno) => {
        if (canceller.isCancellationRequested) { // 检查是否取消操作
            return false;
        }
        if (matchWhole ? line.trim() === pattern.trim() : line.indexOf(pattern) >= 0) { // 检查是否匹配
            return new vscode.Selection(lineno, 0, lineno, 0); // 返回匹配行号
        }
    });
}

// 使用行号查找tag所在行
function getLineNumberLine(entry, document, range, canceller) {
    return eachLine(entry.file, (line, lineno) => {
        if (canceller.isCancellationRequested) {
            return false;
        }
        if (lineno === entry.address.lineNumber) { // 检查行号是否匹配
            return new vscode.Selection(lineno, 0, lineno, 0); // 返回匹配行号
        }
    });
}

// 根据tag的定义查找其位置
function getLineNumber(entry, document, range, canceller) {
    if (entry.address.lineNumber !== undefined) {
        return getLineNumberLine(entry, document, range, canceller); // 使用行号进行查找
    }
    if (entry.address.pattern) {
        return getLineNumberPattern(entry, canceller); // 使用正则表达式进行查找
    }
    return Promise.resolve();
}

// 跳转到tag所在位置
function revealCTags(context, editor, tag) {
    if (!tag) {
        return;
    }

    const uri = vscode.Uri.file(tag.file); // 获取tag所在文件的URI
    const selection = new vscode.Selection(tag.address.lineNumber, 0, tag.address.lineNumber, 0); // 创建光标选择区域
    return saveState(context, editor) // 保存当前状态
        .then(() => openAndReveal(context, editor, uri, selection)); // 打开并跳转到tag位置
}

// 打开文件并跳转到指定位置
function openAndReveal(context, editor, uri, selection) {
    return vscode.workspace.openTextDocument(uri).then(doc => {
        return vscode.window.showTextDocument(doc).then(editor => {
            editor.selection = selection; // 设置当前光标位置
            editor.revealRange(selection, vscode.TextEditorRevealType.Default); // 滚动到该位置
        });
    });
}


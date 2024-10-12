const ctagz = require('ctagz')
const lineReader = require('line-reader')
const path = require('path')
const Promise = require('bluebird')
const vscode = require('vscode')
const eachLine = Promise.promisify(lineReader.eachLine)  // 将line-reader的eachLine函数转化为Promise版本
const child_process = require('child_process');
// const { couldStartTrivia } = require('typescript')

// Called when the plugin is first activated
function activate(context) {
    console.log('ctagsc is live')

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

    // 添加命令，用于执行生成ctags命令
    disposable = vscode.commands.registerCommand('extension.genCtag', generateCTags)
    context.subscriptions.push(disposable)

    // 检查是否禁用了定义提供程序
    if (!vscode.workspace.getConfiguration('ctagsc').get('disableDefinitionProvider')) {
        // 注册定义提供程序，匹配所有文件
        disposable = vscode.languages.registerDefinitionProvider({ pattern: '**/*' }, { provideDefinition });
        // 将定义提供程序添加到上下文的订阅中，以便在扩展被禁用时可以清理
        context.subscriptions.push(disposable);
    }
}
exports.activate = activate

// Called when the plugin is deactivated
function deactivate() {
    console.log('ctagsc is deactivated')
}
exports.deactivate = deactivate

/**
 * 重新生成 ctags
 * @returns Promise,  resolve : stdout, reject : error
 */
function doGenerate() {
    const config = vscode.workspace.getConfiguration('ctagsc');
    const command = config.get('genCtagCommand');
    if (vscode.workspace.workspaceFolders) {
        // 获取当前路径
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/'); // 替换为正斜杠, 获取第一个工作区文件夹路径

        console.log(`Running ctagsc command: ${command}`);
        console.log(`workspacePath pwd :  ${workspacePath}`);
        return new Promise((resolve, reject) => {
            child_process.exec(command || 'ctags --tag-relative --extras=+f -R .', { cwd: workspacePath }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`exec error: ${error}`);
                    reject(error);
                } else if (stderr) {
                    console.error(`stderr: ${stderr}`);
                    resolve(stderr);
                } else {
                    // no error occur
                    resolve(stdout);
                }
            });
        });
    } else {
        return Promise.reject('未打开任何工作区文件夹');
    }
}

/**
 * 
 * @returns     
 */
function generateCTags() {
    // withProgress 方法用于显示进度条
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: 'Generating CTags...'
        },
        (progress, token) => {
            return doGenerate()
                .catch(err => {
                    /**
                     * Promise的catch方法用于捕获Promise被拒绝（rejected）的情况，即当Promise的状态变为rejected时，catch方法会被调用。
                     */
                    vscode.window.setStatusBarMessage('Generating CTags failed: ' + err);
                });
        }
    );
}

function createTerminal() {
    vscode.window.createTerminal().show()
}

function findCTagsFromPrompt(context) {
    const options = {
        'prompt': 'Enter a tag to search for'
    }
    // TODO: Provide completion (jtanx/ctagz#2)
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
 * @param {*} context vscode extension context
 * @returns {Promise}
 */
function findCTagsInDocument(context) {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
        console.log('ctags: Cannot search - no active editor (file too large? https://github.com/Microsoft/vscode/issues/3147)')
        return
    }

    const tag = getTag(editor)
    if (!tag) {
        return
    }

    return findCTags(context, tag)
}

/**
 * Find ctags for a tag, CTRL+T
 * @param {*} context vscode extension context
 * @param {*} tag ctags file
 * @returns
 */
function findCTags(context, tag) {
    const editor = vscode.window.activeTextEditor
    let searchPath = vscode.workspace.rootPath

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
        return vscode.window.showWarningMessage(`ctags: No searchable path (no workspace folder open?)`)
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
                delete tag.kind // #20 -> avoid conflict with QuickPickItem
                return tag
            })

            if (!options.length) {
                if (!result.tagsFile) {
                    return vscode.window.showWarningMessage(`ctags: No tags file found`)
                }
                return vscode.window.showInformationMessage(`ctags: No tags found for ${tag}`)
            } else if (options.length === 1) {
                // 如果tags文件中命中一个entry，则需要去判断是否是函数定义，如果是函数定义，则跳转到函数定义处，否则跳转到声明处
                return revealCTags(context, editor, options[0])
            } else {
                // 如果tags文件中，有多个entry命中，则显示一个QuickPick供用户选择
                return vscode.window.showQuickPick(options)
                    .then(opt => {
                        return revealCTags(context, editor, opt)
                    })
            }
        })
        .catch(err => {
            console.log(err.stack)
            vscode.window.showErrorMessage(`ctags: Search failed: ${err}`)
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
        console.log('ctags: Cannot provide definitions for untitled (unsaved) and/or non-local (non file://) documents')
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
            console.log('ctags: Cannot provide definition without a valid tag (word range)')
            return Promise.reject()
        }
        // 获取光标所在位置的单词作为标签
        tag = document.getText(range)
        // 如果标签为空
        if (!tag) {
            console.log('ctags: Cannot provide definition with an empty tag')
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
                // 获取标签在文档中的位置，可能有多个位置，都添加到结果中
                return getLineNumber(item, document, range, canceller)
                    .then(selections => {
                        // 处理返回的selections数组
                        if (Array.isArray(selections)) {
                            selections.forEach(sel => {
                                // 将位置添加到结果中
                                console.log(`provideDefinitio - sel:\n`, sel)
                                results.push(new vscode.Location(vscode.Uri.file(item.file), sel.start))
                            })
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

/**
 * ALT+T
 * @param {*} context
 * @returns
 */
function jumpBack(context) {
    const stack = context.workspaceState.get('CTAGSC_JUMP_STACK', [])
    if (stack.length > 0) {
        const position = stack.pop()
        return context.workspaceState.update('CTAGSC_JUMP_STACK', stack)
            .then(() => {
                const uri = vscode.Uri.parse(position.uri)
                const sel = new vscode.Selection(position.lineNumber, position.charPos, position.lineNumber, position.charPos)
                return openAndReveal(context, vscode.window.activeTextEditor, uri, sel)
            })
    }
}

function clearJumpStack(context) {
    return context.workspaceState.update('CTAGSC_JUMP_STACK', [])
}

/**
 * @description 保存当前编辑器的位置
 * @param {*} context
 * @param {*} editor
 * @returns
 */
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

    const stack = context.workspaceState.get('CTAGSC_JUMP_STACK', [])
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
    console.log('ctags: Jump stack:', stack)

    return context.workspaceState.update('CTAGSC_JUMP_STACK', stack)
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
 * tags中没有行号，则根据选中的pattern来查询具体的行号
 * @param {*} entry
 * @param {*} canceller
 * @returns {Promise} 返回一个Promise对象，表示操作完成。resolve ：一个 数组，包含 vscode.Selection 对象，表示文件行号。
 * async声明的函数的返回本质上是一个Promise。就是说你只要声明了这个函数是async，那么内部不管你怎么处理，它的返回肯定是个Promise。
 */
async function getLineNumberPattern(entry, canceller) {
    let matchWhole = false
    let pattern = entry.address.pattern
    if (pattern.startsWith("^")) {
        pattern = pattern.substring(1, pattern.length)
    } else {
        console.error(`ctags: Unsupported pattern ${pattern}`)
        return Promise.resolve(0)
    }

    if (pattern.endsWith("$")) {
        pattern = pattern.substring(0, pattern.length - 1)
        matchWhole = true
    }

    let found = 0; // 如果找到了，就 = true
    let lineNumber = 0; // 遍历文件的行数
    let charPos = 0;
    const foundLines = []; // 存放找到的行
    const foundCharPos = []; // 存放找到的字符位置

    /* 是用await声明的Promise异步返回，必须“等待”到有返回值的时候，代码才继续执行下去，
       请记住await是在等待一个Promise的异步返回 */
    await eachLine(entry.file, line => {
        lineNumber += 1;
        if ((matchWhole && line === pattern) || line.startsWith(pattern)) {
            found = true;
            charPos = Math.max(line.indexOf(entry.name), 0);
            console.log(`ctags: Found '${pattern}' at ${lineNumber}:${charPos}`);
            foundLines.push(lineNumber);  // 存放找到的行
            foundCharPos.push(charPos);  // 存放找到的字符位置
        } else if (canceller && canceller.isCancellationRequested) {
            console.log('ctags: Cancelled pattern searching')
            return false  // 实际上返回的是promise.reject， 直接退出了promise 状态
        }
    })
    if (found) { // 找到了
        // 存放找到的tag在这个文件的vscode.Selection
        const selections = []
        // 判断存放的行数是否为0
        if (foundLines.length === 0) {
            // 此时代码有是逻辑错误
            console.log('ctags: Error: foundLines.length === 0');
            // 如果为0,则显示一个提示框，告诉用户没有找到
            vscode.window.showInformationMessage(`ctags: No match found for '${pattern}'`);
        }
        else {
            // 如果找到的entry 大于1，则每个entry都返回一个selection
            
            /**
             * map() 方法创建一个新数组，其结果是该数组中的每个元素是调用一次提供的函数后的返回值。
             * array.map((item,index,arr)=>{
             *   //item是操作的当前元素
             *   //index是操作元素的下表
             *   //arr是需要被操作的元素
             *   //具体需要哪些参数 就传入那个
             * })
             */
            foundLines.map((line, index) => {
                console.log(`c: Found '${pattern}' at ${line}:${foundCharPos[index]}`);
                selections.push(new vscode.Selection(line - 1, foundCharPos[index], line - 1, foundCharPos[index]))
            })
            console.log(`c: getLineNumberPattern selections : `, selections);
        }

        return selections
    }
}


/**
 * 获取文件行号。
 *
 * @param {Object} document - 当前文档对象。
 * @param {Object} sel - 当前选择对象。
 *
 * @returns {Promise} - 返回一个Promise对象，表示操作完成。resolve ：一个 数组，包含 vscode.Selection 对象，表示文件行号。
 */
function getFileLineNumber(document, sel) {
    // 存储 所有的vscode seclection 对象
    const selections = []
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
            console.log(`ctags: Resolved file position to line ${lineNumber + 1}, char ${charPos + 1}`)
            selections.push(new vscode.Selection(lineNumber, charPos, lineNumber, charPos))
            // 返回行号和字符位置 的数组
            return Promise.resolve(selections)
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
 * @returns {Promise} - 返回一个Promise对象，表示操作完成。resolve ：一个 数组，包含 vscode.Selection 对象，用来表示文件行号
 */
function getLineNumber(entry, document, sel, canceller) {
    // 如果条目的行号为0，则使用正则表达式模式获取行号
    if (entry.address.lineNumber === 0) {
        return getLineNumberPattern(entry, canceller)
    } else if (entry.tagKind === 'F') {
        // 如果entry 中number不是0， 同时，如果条目的类型是函数，并且当前文档存在，则获取文件行号
        if (document) {
            return getFileLineNumber(document, sel)
        }
    }

    // 如果条目的行号大于0，也不是函数，则获取行号
    const lineNumber = Math.max(0, entry.address.lineNumber - 1)
    // 最后并返回 selections数组
    const selections = [new vscode.Selection(lineNumber, 0, lineNumber, 0)]
    return Promise.resolve(selections)
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
 * @returns {Promise} - 返回一个Promise对象，表示操作完成。vscode.window.showTextDocument(doc, showOptions)
 * resolve to an editor
 */
function openAndReveal(context, editor, document, sel, doSaveState) {
    // 如果需要保存当前编辑器的状态，则先保存状态
    if (doSaveState) {
        return saveState(context, editor)
            .then(() => {
                openAndReveal(context, editor, document, sel)
            })
    }
    // 打开指定的文档
    return vscode.workspace.openTextDocument(document)
        .then(doc => {
            // 设置显示选项
            const showOptions = {
                viewColumn: editor ? editor.viewColumn : vscode.ViewColumn.One,
                preview: vscode.workspace.getConfiguration('ctagsc').get('openAsPreview'),
                selection: sel
            }
            // 显示文档
            return vscode.window.showTextDocument(doc, showOptions)
        })
}

/**
 * 显示CTags条目。 CTRL + T 快捷键
 *
 * @param {Object} context - 插件上下文对象。
 * @param {Object} editor - 当前活动编辑器对象。
 * @param {Object} entry - 要显示的CTags条目对象。
 *
 * @returns {Promise} - 返回一个Promise对象，表示操作完成。resolve 中的参数是一个 数组，包含 vscode.Selection 对象，表示文件行号
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
        .then(selections => {
            // 存储options数组
            const options = []
            // 处理返回的selections数组
            if (Array.isArray(selections)) {
                selections.forEach(sel => {
                    // 将位置添加到options中，给用户选择
                    const item = { label: `Go to ${entry.file}:${sel.start.line + 1}` };
                    options.push(item)
                })
            }

            console.log("options, ", options)
            // 如果只有一个选项，则直接打开并显示条目的文档和选择
            if (options.length === 1) {
                sel = selections[0]
                return openAndReveal(context, editor, entry.file, sel, true)
            } else if (options.length > 1) {
                // 如果有多个选项，则显示快速选择
                return vscode.window.showQuickPick(options)
                    .then(option => {
                        if (option) {
                            console.log(`You selected: ${option.label}`);
                            // 打开并显示条目的文档和选择
                            sel = selections[options.indexOf(option)]
                            return openAndReveal(context, editor, entry.file, sel, true)
                        } else {
                            /* 如果用户选择了一个项，控制台将打印出所选项的标签。如果用户取消了选择，selection 将会是 undefined */
                            console.log('You cancelled the quick pick');
                        }
                    })
            }
        })
}

# ctagsx README
A working cross-platform ctags implementation.

## Setup
ctagsx requires a tags file to work. This may be generated using [Exuberant Ctags](http://ctags.sourceforge.net). To generate the tags file, a suggested run is:

```
D:\work\Software\ctags-v6.1.0-x64\ctags.exe --tag-relative -R --c++-kinds=+p --fields=+iaS --extras=+q .
ctags --tag-relative --extra=f -R .
D:\work\Software\ctags-v6.1.0-x64\ctags.exe  --tag-relative --extras=+f -R .
```

This will generate a file called `tags`. This may be placed in the same folder as the source file being edited, or any of its parent directories. ctagsx will search and use the tags file that is closest to the source file. The tags file may be named either `tags` or `.tags`.

As of version 1.0.6, ctagsx integrates directly as a definition provider (Go to definition - `F12` or `Ctrl+left click`). This feature may be optionally disabled.

Separate to this, ctagsx also provides another searching mechanism; to search for a tag, press `Ctrl+t`/`Cmd+t`. To jump back to where you searched for a tag, press `Alt+t`. To manually enter the tag to jump to, press `Ctrl+alt+t`/`Cmd+alt+t`.

## Features
* Is cross platform
* Remains relatively fast even on large tags files
* Searches tags files relative to the source file being edited
* Bonus: Added command to create terminal in workspace of active document

## Extension Settings
* `ctagsx.openAsPreview`: Controls if the navigated file will be opened in preview mode (default: `false`)
* `ctagsx.disableDefinitionProvider`: Setting this to true prevents ctagsx from providing definitions via this interface (default: `false`).

## Known Issues
* It is assumed that tags files are sorted, as ctagsx will only perform a binary search on the tags file. If the file is not sorted, then it may generate incorrect results.
* Use while editing very large files may not be supported, due to [limitations](https://github.com/Microsoft/vscode/issues/3147) of Visual Studio Code.
* If the navigated-to line contains multiple occurrences of the tag name, the cursor is only placed at the first occurrence.

## Todo List
* [√]fix : If the navigated-to line contains multiple occurrences of the tag name, the cursor is only placed at the first occurrence
* []fix: when ctrl + click, the cursor is placed at the first occurrence of the tag name, and at this time the click is not done, but the goto definition is executed.

## Release Notes
Please refer to the [changelog](CHANGELOG.md).

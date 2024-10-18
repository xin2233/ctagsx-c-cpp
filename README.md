# ctagsc README
This a modification version from [ctagsx](https://github.com/jtanx/ctagsx). Best for c++ and c.

This is original README.md: [README.md](./README-ctagsx.md)

## Features
- [√]fix : If the navigated-to line contains multiple occurrences of the tag name, the cursor is only placed at the first occurrence
- [√]fix: when ctrl + click, the cursor is placed at the first occurrence of the tag name, and at this time the click is not done, but the goto definition is executed.
- Add genCTags command to generate tags file


## Usage
| Command | Description | keyboard shortcut |
| --- | --- | --- |
| `ctagsc.findCTags` | Search for a tag in the tags file | `Ctrl+T`/`Cmd+T` |
| `ctagsc.jumpBack` | Jump back to the location of the last tag search | `Alt+T` |
| `ctagsc.clearJumpStack` | Clear the jump stack | `Ctrl+Alt+T`/`Cmd+Alt+T` |
| `ctagsc.createTerminal` | Create a terminal in the workspace of the active document | `Ctrl+Shift+T`/`Cmd+Shift+T` |
| `ctagsc.findCTagsFromPrompt` | Search for a tag in the tags file from a prompt |  |
| `ctagsc.findCTagsInDocument` | Search for a tag in the active document | |
| `ctagsc.generateCTags` | Generate a tags file for the active document |  |

## Setup
ctagsc requires a tags file to work. This may be generated using [Exuberant Ctags](http://ctags.sourceforge.net). To generate the tags file, a suggested run is:

```
ctags --tag-relative --extras=+f -R .
```

## Extension Settings
* `ctagsc.openAsPreview`: Controls if the navigated file will be opened in preview mode (default: `false`)
* `ctagsc.disableDefinitionProvider`: Setting this to true prevents ctagsc from providing definitions via this interface (default: `false`).

## Attenion
- This extension will conflict witn `cscope-code` extension.


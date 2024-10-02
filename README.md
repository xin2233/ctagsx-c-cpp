# ctagsx-c-cpp README
This a modification version from ctagsx. Best for c++ and c.

This is original README.md: [README.md](./README-origin.md)

## Features
- [√]fix : If the navigated-to line contains multiple occurrences of the tag name, the cursor is only placed at the first occurrence
- [√]fix: when ctrl + click, the cursor is placed at the first occurrence of the tag name, and at this time the click is not done, but the goto definition is executed.

## Usage
| Command | Description | keyboard shortcut |
| --- | --- | --- |
| `ctagsx.findCTags` | Search for a tag in the tags file | `Ctrl+T`/`Cmd+T` |
| `ctagsx.jumpBack` | Jump back to the location of the last tag search | `Alt+T` |
| `ctagsx.clearJumpStack` | Clear the jump stack | `Ctrl+Alt+T`/`Cmd+Alt+T` |
| `ctagsx.createTerminal` | Create a terminal in the workspace of the active document | `Ctrl+Shift+T`/`Cmd+Shift+T` |
| `ctagsx.findCTagsFromPrompt` | Search for a tag in the tags file from a prompt |  |
| `ctagsx.findCTagsInDocument` | Search for a tag in the active document | |
| `ctagsx.generateTags` | Generate a tags file for the active document |  |

## Setup
ctagsx requires a tags file to work. This may be generated using [Exuberant Ctags](http://ctags.sourceforge.net). To generate the tags file, a suggested run is:

```
ctags --tag-relative --extras=+f -R .
```

## Extension Settings
* `ctagsx.openAsPreview`: Controls if the navigated file will be opened in preview mode (default: `false`)
* `ctagsx.disableDefinitionProvider`: Setting this to true prevents ctagsx from providing definitions via this interface (default: `false`).


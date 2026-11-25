# Instinct plugins

Plugins for AI assistants. A plugin is a guide in its own folder: the assistant reads it and follows its instructions. Nothing is installed or run by the plugin itself.

Each plugin lives in its own folder, with a README.md that holds the full instructions.

## Plugins

| Plugin | What it does | Guide |
| --- | --- | --- |
| whatsapp | Links a user's WhatsApp with a phone-number code and reads chats on request | [whatsapp/README.md](whatsapp/README.md) |
| form-creator | Make a form by chatting, share a link, read the answers in the chat | [form-creator/README.md](form-creator/README.md) |

## Browse the catalog

A machine-readable list of all plugins is in [index.json](index.json). To let an assistant browse it and show you what exists, see [browse/README.md](browse/README.md). Browsing only reads; nothing is installed without your approval.

## Announcements

Optional updates about this project for users who opt in. See [announcements/README.md](announcements/README.md).

## How to use a plugin

Paste the plugin's short prompt to your assistant. The assistant opens the guide and follows it. A plugin does not give permissions and does not override the user's instructions or the assistant's own limits.

## Adding a plugin

Create a folder with a README.md, then add a row to the table above.

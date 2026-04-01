# Chat

ChatGPT-style conversational interface with real-time tool tracking, session management, and file uploads.

![Chat](/images/chat.jpg)

## Features

- **Real-time streaming** — Claude responses stream in real-time as they are generated
- **Tool visualization** — Visual display of Read, Edit, Bash, and other tool executions with expandable details
- **Slash commands** — Built-in commands (`/model`, `/memory`, `/skills`, etc.) with autocomplete
- **`/btw` side questions** — Ask Claude a quick follow-up without interrupting the current task
- **Sub-agent panel** — Monitor and inspect nested agent tool calls in real time
- **Session persistence** — All conversations are saved to SQLite and can be resumed later
- **Session pinning** — Pin important conversations to the top of the sidebar
- **File attachments** — Drag-and-drop file and image uploads, sent as context to Claude
- **Dark / light theme** — One-click theme toggle
- **Bilingual interface** — English and Chinese with runtime language switching
- **Mobile-responsive** — Full functionality on mobile devices with responsive layout

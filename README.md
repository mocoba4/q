# Website Monitor 🐱

This is an automated tool that checks the website every 5 minutes. If it finds that "work is available" (meaning the "all tasks picked up" message is gone), it sends you a message on Telegram instantly.

## 🚀 How to Set This Up

### Step 1: Create a Telegram Bot
You need to create a bot to receive messages.
1. Open Telegram and search for **@BotFather**.
2. Click **Start** and type `/newbot`.
3. Give it a name (e.g., "Task Alert").
4. Give it a unique username (e.g., `TaskAlert123_bot`).
5. **Copy the API Token** it gives you (it looks like `123456:ABC-DEF...`). Save this for later.

### Step 2: Get Your Chat ID (For User OR Group)

**Option A: Send to just YOU**
1. Search for **@userinfobot**.
2. Click **Start**.
3. It will show your "Id". Copy this number.

**Option B: Send to a GROUP / CHANNEL**
1. Create a Telegram Group.
2. **Add your new bot** to the group as a member.
3. Open this link in your browser (replace `<YOUR_TOKEN>` with the token from Step 1):
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Send a message (e.g., "Hello") in the group.
5. Refresh the browser page.
6. Look for data that looks like `"chat":{"id":-100123456789...`.
7. **Copy that number** (including the minus sign `-`). That is your Group Chat ID.

### Step 3: Put this Code on GitHub
1. Create a **New Repository** on GitHub (Make it **Public**).
2. Upload all the files in this folder to that repository.
3. (Or if you know how to use Git, push this code to the new repo).

### Step 4: Add Secrets (The Most Important Step!)
For the bot to work, you need to give it your login info and Telegram keys securely.
1. Go to your GitHub Repository page.
2. Click **Settings** (top right tab).
3. On the left menu, scroll down to **Secrets and variables** and click **Actions**.
4. Click the green button **New repository secret**.
5. You need to create **4 separate secrets**.

⚠️ **IMPORTANT:** When copying the "Name", ONLY copy the text in the code block. Do NOT include spaces, colons, or any other text.

---

### Secret #1
**Name** (Copy this EXACTLY):
`CG_EMAIL`

**Secret** (Paste your email):
`john.doe@gmail.com`

---

### Secret #2
**Name** (Copy this EXACTLY):
`CG_PASSWORD`

**Secret** (Paste your password):
`mySuperSecretPassword123`

---

### Secret #3
**Name** (Copy this EXACTLY):
`TELEGRAM_BOT_TOKEN`

**Secret** (Paste your token):
`123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

---

### Secret #4
**Name** (Copy this EXACTLY):
`TELEGRAM_CHAT_ID`

**Secret** (Paste your Chat ID):
`123456789`

---

### Secret #5
**Name**: `TARGET_URL`
**Secret**: `https://example.com/tasks`
*(Replace with the actual tasks URL)*

---

### Secret #6
**Name**: `LOGIN_URL`
**Secret**: `https://example.com/login`
*(Replace with the actual login URL)*

---

---

## 💻 How to Test on Your PC (Optional)
If you want to run this right now on your computer to see if it works:

1.  Open the folder `checker/` on your computer.
2.  Look for a file named `.env.example`.
3.  **Rename** it to `.env` (just `.env`, no `.txt` or anything else).
4.  Open `.env` with Notepad.
5.  Replace the values with your real email, password, etc. Save it.
6.  Open a terminal (Command Prompt) in the `checker` folder.
7.  Type `node index.js` and press Enter.

You should see it open a browser (in the background) and print what it is doing.

## ❓ Troubleshooting

**Q: I'm not getting alerts!**
A: This usually means there are no tasks (the specific "not found" phrase is present). Check the "Actions" tab in GitHub to see if the "Website Checker" workflow is running green.

**Q: The login isn't working.**
A: Double-check your `CG_EMAIL` and `CG_PASSWORD` in the Secrets settings. Ensure they are correct and have no extra spaces.

**Q: I want to stop it.**
A: Go to the "Actions" tab, click "Website Checker" on the left, check the three dots `...` and select "Disable workflow".

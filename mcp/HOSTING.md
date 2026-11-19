# Hosting the Prayer Tower connector on Hostinger

This guide puts the Prayer Tower MCP server on the internet at
`https://mcp.amazinggodinternationalministries.com`, so anyone you allow can manage prayer requests
from **claude.ai in a browser or the Claude mobile app**. No computer needs to stay on.

You don't need to be a developer. You will copy a few values between GitHub, Hostinger and Claude.
Budget about 45 minutes the first time.

## How it fits together

```
 You, in Claude (web or phone)
        |  "Add a prayer request for ... then publish"
        v
 Claude  --HTTPS-->  Your Hostinger app  (mcp.amazinggodinternationalministries.com)
                       |  1. asks you to sign in with GitHub (only allowed usernames get in)
                       |  2. reads / edits data/prayers.json in the repo with its own GitHub token
                       v
                 GitHub repo agimusa/prayer-tower  (data/prayers.json)
                       |  a commit (or merged pull request) on the website branch
                       v
                 The Prayer Tower website updates
```

- **Claude** talks to your app. It never sees your GitHub token.
- **Sign in with GitHub** only proves *who* you are. The app asks GitHub for your public profile (`read:user`)
  and nothing else. The username must be on your allow list.
- **The app** makes changes in GitHub with one token that you create (Step 2).

## What you need

- A Hostinger **Business Web Hosting** or **Cloud** plan. These plans include Node.js Web Apps (docs.hostinger.com).
- Access to the domain `amazinggodinternationalministries.com` in Hostinger (to create the `mcp.` subdomain).
- A GitHub account that can manage the `agimusa` organization, or one that an `agimusa` owner can approve tokens for.
- A Claude account (Free, Pro, Max, Team or Enterprise). The Free plan allows **one** custom connector.
- About 10 minutes of uninterrupted copy-paste time for Steps 1 to 3. Keep a private note open for the secrets.
  Never put them in a chat, an email or a file in the repo.

---

## Step 1. Create a GitHub OAuth App (the "Sign in with GitHub" button)

1. Go to **github.com → your profile picture → Settings → Developer settings → OAuth Apps → New OAuth App**
   (https://github.com/settings/developers).
   To make the organization own it instead, go to **github.com/agimusa → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:

   | Field | Value |
   |---|---|
   | Application name | `Prayer Tower (Claude connector)` |
   | Homepage URL | `https://mcp.amazinggodinternationalministries.com` |
   | Authorization callback URL | `https://mcp.amazinggodinternationalministries.com/oauth/github/callback` |
   | Enable Device Flow | leave unticked |

3. Click **Register application**.
4. Copy the **Client ID** into your private note as `GITHUB_OAUTH_CLIENT_ID`.
5. Click **Generate a new client secret**, and copy it right away as `GITHUB_OAUTH_CLIENT_SECRET`.
   GitHub shows it only once.

The callback URL must match exactly: `https`, no `www`, and no trailing slash.

## Step 2. Create the GitHub token the app uses to edit prayers

This is a **fine-grained personal access token**. It can touch only the prayer-tower repository.

1. **github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.**
2. **Token name:** `prayer-tower-mcp (Hostinger)`.
3. **Resource owner:** `agimusa`.
4. **Expiration:** choose a date, for example 1 year. Put a reminder in your calendar a week before it ends.
   When it expires, publishing stops working until you replace the token (see *Managing users*, below).
5. **Repository access:** *Only select repositories* → `agimusa/prayer-tower`.
6. **Repository permissions:**
   - **Contents: Read and write**
   - **Pull requests: Read and write**
   - Metadata: Read-only is added automatically. Leave everything else at *No access*.
7. Click **Generate token** and copy it as `GITHUB_TOKEN` (it starts with `github_pat_`).
8. If `agimusa` requires approval for fine-grained tokens, the token stays **pending** until an organization owner approves it
   (**github.com/agimusa → Settings → Personal access tokens → Pending requests**). It will not work until then.

## Step 3. Make a session secret

The app signs everyone's sign-in with this secret. It must be at least 32 characters and random.

- With Node.js installed on any computer, run:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- Or in Windows PowerShell:

  ```powershell
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { '{0:x2}' -f $_ })
  ```

Copy the result as `SESSION_SECRET`.

Changing `SESSION_SECRET` later signs **everyone** out. Each person then has to click **Connect** on the connector in
Claude again. If that keeps failing, remove the connector and add it again (Step 7).

## Step 4. Create the website and the Node.js app in Hostinger

Hostinger treats a subdomain as its own website.

1. In **hPanel**, go to **Websites → Add Website → Web App (Node.js)** (docs.hostinger.com).
2. Choose the domain **`mcp.amazinggodinternationalministries.com`**. If hPanel asks, create it as a subdomain of `amazinggodinternationalministries.com`.
3. Choose how to get the code. **GitHub is recommended**, because every push redeploys automatically.

### Option A (recommended): deploy from GitHub

1. Choose **GitHub** and connect your GitHub account. Hostinger installs its GitHub App. Private repositories work.
   Give it access to `agimusa/prayer-tower`. An `agimusa` owner may need to approve the app.
2. Repository: **`agimusa/prayer-tower`**.
3. Branch: **`feature/mcp-server`** for now. The server code is only on that branch until it is merged; after the merge, switch to **`main`**.
   Hostinger redeploys automatically whenever someone pushes to the chosen branch.
4. Build settings:

   | Setting | Value |
   |---|---|
   | Framework preset | **Express** (or **Other**) |
   | Node version | **22** |
   | Root directory | **`mcp`** |
   | Build command | **`bundle`** |
   | Entry file | **`server.js`** |

   - **Build command** is the *name* of a script in `mcp/package.json`. `bundle` packs the server into one file
     (`dist/http.bundle.mjs`) and needs only normal dependencies. `build` also works, but only if Hostinger installs
     development tools too, and we could not confirm that it does. So use `bundle`.
   - **Entry file** `server.js` starts the server. Hostinger has no separate start command.
5. Add the environment variables from Step 5 in the same form (or add them afterwards under **Environment variables**).
6. Click **Deploy**.

### Option B: upload a ready-made zip

Use this if you can't connect GitHub. A developer runs, inside the `mcp` folder:

```bash
npm install
npm run package:hostinger
```

This creates `mcp/release/prayer-tower-mcp-hostinger.zip` (about 0.6 MB). It contains `package.json`, `server.js` and
`dist/http.bundle.mjs`, with every dependency built in, so nothing needs installing or building.

1. Choose **Upload** and upload the zip.
2. Framework preset **Express** or **Other**, Node version **22**, Root directory left empty (the zip's top level),
   Build command **empty**, Entry file **`server.js`**.
3. Add the environment variables (Step 5) and deploy.

With a zip, updates don't happen automatically. Upload a new zip whenever the server code changes.

## Step 5. Environment variables

Enter these in the deploy form, or later under the website's **Environment variables**. Names are UPPERCASE.
Saving the variables redeploys the app.

| Name | Required? | Example | What it means |
|---|---|---|---|
| `PUBLIC_URL` | **Yes** | `https://mcp.amazinggodinternationalministries.com` | The app's public address. Use `https://`, with no path and no trailing slash. It must be exactly the address people reach. |
| `SESSION_SECRET` | **Yes** | *(64 hex characters from Step 3)* | Signs sign-ins and tokens. Changing it signs everyone out. |
| `GITHUB_OAUTH_CLIENT_ID` | **Yes** | `Ov23li...` | Client ID from Step 1. |
| `GITHUB_OAUTH_CLIENT_SECRET` | **Yes** | *(from Step 1)* | Client secret from Step 1. |
| `ALLOWED_GITHUB_USERS` | **Yes** | `pastor-john,maryk,prashanth` | GitHub usernames allowed to use the connector, separated by commas. Upper or lower case doesn't matter. Anyone else is refused. |
| `GITHUB_TOKEN` | **Yes** | `github_pat_...` | The fine-grained token from Step 2. The app uses it for every change. |
| `PRAYER_TOWER_REPO` | No | `agimusa/prayer-tower` | Repository to edit. The default is right. |
| `PRAYER_TOWER_BRANCH` | Yes, for now | `feature/mcp-server` | Branch that holds `data/prayers.json`. **That file exists only on `feature/mcp-server` until the branch is merged**, so set `feature/mcp-server` for now. After the merge, set `main` (or delete the variable, because `main` is the default). The website only changes when `main` changes. |
| `PRAYER_TOWER_FILE` | No | `data/prayers.json` | Path of the data file. The default is right. |
| `PRAYER_TOWER_PUBLISH_MODE` | Recommended | `direct` | How **publish** saves changes. **`direct`** commits straight to the branch, so the site updates within a minute or two. Claude still has to show you the preview and get your OK first: the server refuses a direct publish without `confirm: true`. **`pr`** (the default) opens a pull request instead. That's safer, but someone must merge it on GitHub before the site changes. |
| `PORT` | **Do not set** | *(none)* | Hostinger provides it automatically. |

## Step 6. Deploy, turn on HTTPS, and check it

1. Wait for the deployment to finish. If it fails, open **Runtime Logs** in the website's sidebar (see Troubleshooting).
2. Make sure SSL is on for `mcp.amazinggodinternationalministries.com`. Hostinger provides free SSL; also turn on **Force HTTPS**.
3. In a browser, open:
   - `https://mcp.amazinggodinternationalministries.com/healthz` should show `{"ok":true,"version":"0.1.0","mode":"github"}`.
   - `https://mcp.amazinggodinternationalministries.com/.well-known/oauth-protected-resource` should show JSON with
     `"resource":"https://mcp.amazinggodinternationalministries.com/mcp"`.
   - `https://mcp.amazinggodinternationalministries.com/` should show a short page about the connector.

   If either JSON page doesn't load, don't continue to Step 7. Go to Troubleshooting.

Claude's servers must be able to reach this address, so keep these rules (claude.com docs):
- Plain HTTPS on port 443, with a normal IPv4 (A) record for `mcp.amazinggodinternationalministries.com`.
- **No redirects to a different host** on the MCP address, for example to `www.` or to another domain.
- Firewall or "bot protection" features must not block Claude's address range **`160.79.104.0/21`**. A 403 or 429 from a
  firewall breaks the connector.

## Step 7. Add the connector in Claude

### Personal plan (Free, Pro, Max)

1. On **claude.ai** (in a web browser), go to **Customize → Connectors**.
2. Click **Add → Add custom connector**.
3. **Name:** `Prayer Tower`. **Remote MCP server URL:** `https://mcp.amazinggodinternationalministries.com/mcp`
   (note `/mcp` at the end). Click **Continue** if it appears.
4. Authentication settings (claude.com docs):
   - **Authentication:** **Sign in now**.
   - **OAuth client:** **Register automatically**. If Claude marks an option **Detected**, keep it. Don't pick
     "Use Claude's published identity", because this server doesn't support that method.
     Don't pick "Use your own OAuth client". The GitHub OAuth App from Step 1 belongs to the server, not to Claude.
   - Leave Request headers and Transport alone.
5. Click **Add**, then **Connect**. A GitHub page asks you to authorize **Prayer Tower (Claude connector)**. Approve it.
   If your username is on `ALLOWED_GITHUB_USERS`, you return to Claude connected.

You can't change authentication settings after adding the connector. To change them, remove the connector and add it again.

### Team or Enterprise plan

An Owner goes to **Organization settings → Connectors → Add → Custom → Web**, enters the same name and URL, and
uses the same authentication choices. Each member then goes to **Customize → Connectors**, finds **Prayer Tower**
(labelled *Custom*) and clicks **Connect**. Every member still needs their GitHub username on `ALLOWED_GITHUB_USERS`.

### On your phone

Connect once on the web (above). After that, the connector is available in the Claude mobile app on the same account.

### First test

Start a new chat, make sure **Prayer Tower** is switched on (the **+** button → **Connectors**), and try:

> Add a prayer request for Samuel Newton, Twinkle Amjala's elder brother: healing from diabetes complications. Then publish it.

Claude should search for existing entries, add the request in English and Telugu, show you a preview, and ask before
publishing. Answer "yes, publish". With `direct` mode it replies with a commit link. With `pr` mode it replies with a
pull request link, and someone must merge it.

---

## Managing users

- **Add or remove someone:** edit `ALLOWED_GITHUB_USERS` under **Environment variables** and save. Hostinger redeploys.
  When it's back up, the change takes effect at once: a removed user is refused on their next request, even if they connected before.
- **Each new person** adds the connector in their own Claude (Step 7) and signs in with their own GitHub account.
  They don't need any access to the GitHub repository. The app's token (Step 2) does the writing.
- **Replace an expiring token:** create a new token (Step 2), paste it into `GITHUB_TOKEN`, save. Nobody needs to reconnect.
- **Sign everyone out:** change `SESSION_SECRET`.

## How it behaves

- **Drafts live in memory, per person.** Edits wait in a draft until you **publish**. Publish in the same conversation,
  soon after editing. The draft is lost if the app restarts (after a redeploy, or when it sleeps). Nothing is lost from the website.
- **Publish is safe against other edits.** It re-reads the latest file from GitHub and replays your changes on top,
  so edits made in the meantime on the website are kept.
- **The first request after a quiet period is slow.** Hostinger stops idle apps and starts them on the next request.
  The first tool call can take a few seconds; if Claude reports a failure, just ask again.
- **Time limits.** Hostinger allows each request up to 120 seconds and Claude allows a tool call up to 240 seconds.
  Normal calls take one to three seconds.
- **Nothing is stored on Hostinger.** The app keeps no files. Hostinger overwrites its folder on every deploy. All data is in GitHub.

## Security notes

- **Secrets stay in Hostinger.** Keep `GITHUB_TOKEN`, `GITHUB_OAUTH_CLIENT_SECRET` and `SESSION_SECRET` only in
  Hostinger's Environment variables and your private note. Never commit them to the repo or paste them into a chat.
  The app never writes the token to its logs.
- **Least privilege.** The GitHub token can reach only `agimusa/prayer-tower`, with Contents and Pull requests
  permissions. Sign-in asks GitHub only for `read:user`.
- **Allow list.** Only usernames on `ALLOWED_GITHUB_USERS` get in. Anyone else sees "not allowed" after signing in.
- **Session lifetime.** Access lasts 1 hour and renews automatically. After 30 days without use, you click **Connect** again.
- **Confirmed publishing.** A direct publish requires `confirm: true`. Claude is instructed to set it only after
  showing you the preview and getting your explicit OK. For extra safety, use `PRAYER_TOWER_PUBLISH_MODE=pr`.
- **Revert a bad change.** Every change is a normal Git commit, so you can always revert it on GitHub.
- **Leaked secret.** If a secret leaks, regenerate it on GitHub (Steps 1 and 2) or make a new `SESSION_SECRET`, then update the variable.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| App won't start; `/healthz` gives 503 or an error page | A required variable is missing or wrong | Open **Runtime Logs**. The app prints `cannot start:` followed by every missing or invalid variable (for example `Missing required environment variable(s): SESSION_SECRET`). Fix them and save. |
| Logs say `SESSION_SECRET must be at least 32 characters` | The secret is too short | Make a new one (Step 3). |
| Logs say `PUBLIC_URL must use https://` or `must be an origin only` | Wrong `PUBLIC_URL` | Use exactly `https://mcp.amazinggodinternationalministries.com`, with no `/mcp` and no trailing `/`. |
| Deploy fails at the build step | The build command or root directory is wrong, or development tools aren't installed | Root directory `mcp`, Build command `bundle` (not `build`), Entry file `server.js`, Node 22. Or use the zip (Option B). |
| GitHub says **"The redirect_uri is not associated with this application"** | The OAuth App callback URL doesn't match | In the OAuth App (Step 1), set the callback to exactly `https://mcp.amazinggodinternationalministries.com/oauth/github/callback`, and make sure `PUBLIC_URL` uses the same host. |
| Claude says **authorization failed** or couldn't connect | The server is unreachable from Claude, was asleep, or uses a different address | Check that `/healthz` loads over https. Try **Connect** again (the first try may hit a cold start). The connector URL must end in `/mcp`. Check `PUBLIC_URL`. |
| Signed in, then a page says **"not allowed to use the Prayer Tower connector"** (403) | Your username isn't on the allow list | Add the exact GitHub username to `ALLOWED_GITHUB_USERS`, save, wait for the redeploy, and click **Connect** again. |
| It worked before, now every call fails with **401** or asks you to reconnect | `SESSION_SECRET` changed, or you were idle more than 30 days | Click **Connect** on the connector. If that fails, remove the connector and add it again. |
| Tools fail with **401, 403 or 404 from GitHub** | The token expired, isn't approved yet, lacks permissions, or the branch or file is wrong | Check the token (Step 2) and org approval. `PRAYER_TOWER_BRANCH` must be a branch that has `data/prayers.json` (`feature/mcp-server` until it's merged). |
| Claude says it published, but the **website didn't change** | `pr` mode (the pull request isn't merged), or the change went to a branch the site doesn't use | Merge the pull request, or switch to `direct`. The site publishes from `main`, so changes on `feature/mcp-server` don't show until merged. GitHub Pages can take a minute or two. If the site itself is hosted on Hostinger as a static site, check that it rebuilds from `main` too. |
| The connector never connects, but `/healthz` works in your browser | A firewall, WAF or bot protection is blocking Claude, or there's a redirect | Allow `160.79.104.0/21`. Make sure the address doesn't redirect to `www.` or another host. Make sure it has an IPv4 (A) record. |
| An edit vanished before publishing | The app restarted (redeploy or idle), so the in-memory draft was lost | Ask Claude to make the edit again and publish in the same conversation. |
| "Direct publish … requires confirm: true" | Working as intended | Approve the preview, and Claude retries with confirmation. |

## Not confirmed

Hostinger's documentation doesn't say these things, so we built around them:

- **Whether Hostinger installs development dependencies before the build command runs.** The `bundle` build command
  and the zip don't need them. We tested `npm ci --omit=dev` followed by `npm run bundle`.
- **Exactly how Hostinger launches the entry file** (plain `node server.js` or a wrapper). `server.js` always starts the
  server, so either way works.
- **Exact hPanel labels**, which may differ slightly from those in this guide as Hostinger updates its panel.

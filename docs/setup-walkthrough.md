# Setup walkthrough

A plain-language guide to the setup steps only you can take, one at a time, in this order. Each one keeps the agents from doing anything to your project that you have not approved. The full technical detail is in [GitHub](github.md).

Keeping the project only on this machine has no GitHub steps; [local mode](local-mode.md) explains that path and what it gives up.

In the commands below, `<proteus>` is the folder Proteus is installed in; `/proteus:setup` shows each command with the full path filled in. Inside a Claude Code session, type `!` and a space before a command, so its output lands in the chat. After each step, check it worked with:

```bash
node <proteus>/install.js --doctor
```

## 1. An account for the agents

**What it is for:** the agents get a GitHub account of their own, so everything they write is marked as theirs, and only your account can approve their work.

**What to do:** create a second GitHub account that you control, the same way you created your own. Stay signed in to your own account in your usual browser window; you will sign in to the new one in the next step.

**How to tell it worked:** this step has no row of its own; step 2 checks it.

## 2. Sign the agents in

**What it is for:** this machine learns which account is yours and which is the agents', so the agents' commands always run as their account and never as you.

**What to do:** first make sure this machine is signed in to your own account: `--doctor` shows `ok   gh logged in`, and if it does not, run `gh auth login`. Then, once per machine, run:

```bash
node <proteus>/install.js --agent-login
```

When it shows a code, open a private browser window, sign in there as the agents' account, and enter the code.

**How to tell it worked:** `--doctor` shows `ok   identity=separate: agents post as <their account>, you as <you>`.

## 3. Protect the project

**What it is for:** nothing reaches your project's shared work unless its checks passed and a reviewer signed off, and nobody can skip that, the agents and you included.

**What to do:** once per project, as its owner, from inside it, run:

```bash
node <proteus>/install.js --protect
```

It also proposes one small change to your project, named in its output as `merge PR #<n>`. Accept it on GitHub: open your project's **Pull requests** tab, open that number, and press **Merge pull request**.

**How to tell it worked:** `--doctor` shows `ok   <their account> has write on <your project>`, `ok   proteus/* ruleset: …` and `ok   .github/workflows/proteus-trust.yml on <branch> matches the template`.

## 4. A signature only the reviewers hold

**What it is for:** the agents share one account, so this gives the reviewers' approval a separate signature no other agent has, and step 3's protection then accepts an approval only with that signature.

**What to do:** once per project, as its owner, follow these screens on GitHub:

1. Create a GitHub App (Settings > Developer settings > GitHub Apps > New): any name and homepage URL, **Webhook** unticked, and under Repository permissions only **Commit statuses: Read and write**. Nothing else.
2. On the App's settings page, open the **Install App** tab, install it on the account or organization that owns the project, and choose **Only select repositories** with this project.
3. In the left menu open **Credentials**, then the **Key pairs** tab, and generate a private key; your browser downloads a `.pem` file. Note the App ID on the **General** tab.
4. Move the key out of your downloads into a folder only you can read, as [GitHub](github.md#verifier-app-recommended) step 4 shows for your system.
5. Record it, from inside the project, with the App ID and the key's new path:

   ```bash
   node <proteus>/install.js --verifier-app <appId> <keyPath>
   ```

6. Run `node <proteus>/install.js --protect` again, so the protection accepts approvals only with the App's signature.

**How to tell it worked:** `--doctor` shows `ok   verifier App <appId>: key <keyPath> readable`, `ok   verifier App <appId>: a token mints for <your project>`, and the `proteus/* ruleset` row ends with `(the verdicts from App <appId>)`.

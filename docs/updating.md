# Updating

The plugin updates through the plugin manager, from the tag the marketplace is pinned to. To move the pin to a newer release, here `v2.0.1`:

```bash
claude plugin marketplace remove proteus --scope user && claude plugin marketplace add Yousef-Baidas/proteus#v2.0.1 && claude plugin install proteus@proteus && claude plugin update proteus@proteus
```

Re-adding a marketplace at another tag fails while your user settings still name it at the old one, so the entry goes first. A repo whose `.claude/settings.json` lists the marketplace keeps the plugin installed through the remove, and `update` moves it. Elsewhere the remove uninstalls the plugin, and `install` brings it back at the new tag. With no `proteus` entry in your user settings, drop the first command. The session start's release check prints this same line, with your marketplace's source and the newest verified tag, when the installed commit is not a verified release.

With the installer:

```bash
node ~/proteus/install.js --update     # from inside a Proteus repo also refreshes that repo
```

`--update` fetches the checkout's tags and moves it to the newest release tag (`vX.Y.Z`) past it, only by fast-forward and only once `git verify-tag` accepts the tag's signature (see [Releases](#releases)); it refuses an unsigned or untrusted tag, a dirty checkout, and a tag that does not contain your checkout's HEAD. It never moves to the tip of a branch. It prints the `CHANGELOG.md` sections between the two versions (or, without any, the new `feat` and `fix` commits), then re-runs the updated installer, adding `--project` when the current repo has Proteus hooks (the checkout itself too, once self-hosted); with no newer release it only re-runs the installer. `--project` never overwrites your `PROFILE.md`, `ROUTING.md`, or `skills.txt`; it refreshes the link scripts, templates, `required.txt`, and the hooks. Instead `teams/.proteus-base.json` records the shipped text each of those three came from. When a release changes one that your copy has moved away from, `--project` writes the new text beside it as `<file>.upstream`, and the old shipped text as `<file>.base` when this checkout's history still has it. Both files are excluded from git. It prints one line with the `git merge-file <file> <file>.base <file>.upstream` command to run, and `--doctor` lists any `.upstream` still pending. Merge it, then delete both. Commit the `teams/` changes, `.proteus-base.json` included. A link at `.proteus-base.json` or at a `.upstream` or `.base` path stops the run before anything is written through it.

On Claude Code, `--update` also moves you to the plugin: it installs `proteus@proteus` at user scope through the `claude` CLI, pinned to the verified release the checkout is now on, then runs `--migrate` to move every 1.x repo it finds ([Moving from 1.x](migrating.md#moving-from-1x)). Without the `claude` CLI it prints the `/plugin` commands to type; with `gh` logged out or offline it installs nothing and the 1.x install is refreshed as before. Codex keeps the installer.

Prefer not to think about it: `node ~/proteus/install.js --auto-update`. The session-start hook then fetches the checkout and its tags at most once a day, and when a newer release tag passes the same checks it fast-forwards a clean checkout to it, re-syncs the hooks and agents, and shows the changelog for the versions in between in a few lines. A tag that fails a check is not applied: one line in the session says why and how to update by hand. So does a checkout with local changes, or one git will not fast-forward, so you know you have fallen behind; a session at the newest release prints nothing. On a release that ships the plugin, it also runs `install.js --update` in the background at most once a day until `proteus@proteus` is installed (needs the `claude` CLI on PATH), with its output in `proteus-update.log` beside `proteus.json`. `--no-auto-update` turns it off. With it off, the status line shows `proteus: update ready` once the daily fetch finds a newer release, and the lead mentions it once. Following `main` instead is a manual choice: `git -C ~/proteus pull --ff-only`, then `node ~/proteus/install.js --update`.

## Releases

A release is a signed annotated tag `vX.Y.Z` on `main`, with its notes under `## [X.Y.Z]` in `CHANGELOG.md`. The maintainer runs `node scripts/changelog.js --release X.Y.Z` to fold the `changelog.d/` fragments under the new version, commits, and tags that commit. `scripts/known-blobs.json` lists every version a shipped file had on `main`, so setup from the plugin (which has no git history) can tell an old copy from an edit; a PR that changes `agents/` or `templates/` regenerates it with `node scripts/known-blobs.js`, and `tests/knownblobs.test.js` fails until it does:

```bash
git tag -s v1.2.0 -m "v1.2.0"          # GPG: signs with user.signingkey from your keyring
git -c gpg.format=ssh -c user.signingkey=$HOME/.ssh/id_ed25519.pub tag -s v1.2.0 -m "v1.2.0"   # SSH key instead
git push origin main v1.2.0
```

To sign every tag with SSH, set it once: `git config --global gpg.format ssh` and `git config --global user.signingkey "$HOME/.ssh/id_ed25519.pub"`. Lightweight tags (`git tag v1.2.0`) carry no signature, so no install takes them.

Updates use your own git's trust, so nothing updates until you opt in to the maintainer's key. Fetch the key from a source you trust (not from the checkout it will verify), then, scoped to the Proteus checkout:

- SSH signatures: put one line `<email> <key type> <key>` (for example `maintainer@example.com ssh-ed25519 AAAA…`) in a file outside the checkout, then `git -C ~/proteus config gpg.ssh.allowedSignersFile ~/.config/proteus/allowed_signers`.
- GPG signatures: `gpg --import maintainer.asc`. git accepts a good signature from any key in your keyring; `git -C ~/proteus config gpg.minTrustLevel fully` limits it to keys you have certified (`gpg --lsign-key <fingerprint>`).

Check it by hand: `git -C ~/proteus fetch --tags && git -C ~/proteus verify-tag v1.2.0`.

Installed as a Claude Code plugin, Proteus does not update itself: the plugin manager does. Each session start instead checks that the installed commit is a release tag signed by the key in `~/.config/proteus/allowed_signers` (the file the blocks below write), using a bare clone of the marketplace's repo in the plugin's data dir that fetches tags at most once a day. A commit that is not (`main`, an unsigned or untrusted tag) gets one warning line naming the newest verified release and the commands that pin to it ([Updating](#updating)); nothing is blocked. `--doctor` shows the last result.

The maintainer's key: Proteus releases are signed with SSH key `SHA256:A3x02EpaNSOo27K8lsm8H3M2hhUpAeGGvoobs8NOsss` (ED25519), published as a signing key of the GitHub account [Yousef-Baidas](https://api.github.com/users/Yousef-Baidas/ssh_signing_keys). To trust it, check the fingerprint the block prints against the one above before you run its `git config` line. In bash:

```bash
mkdir -p ~/.config/proteus
key=$(gh api users/Yousef-Baidas/ssh_signing_keys -q '.[] | select(.title == "proteus tag signing") | .key')
echo "proteus namespaces=\"git\" $key" > ~/.config/proteus/allowed_signers
ssh-keygen -lf <(echo "$key")
git -C ~/proteus config gpg.ssh.allowedSignersFile ~/.config/proteus/allowed_signers
```

In PowerShell (5.1 or 7; the `ForEach-Object` unrolls the array, which 5.1's `ConvertFrom-Json` passes on as one object):

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\proteus" | Out-Null
$key = ((gh api users/Yousef-Baidas/ssh_signing_keys | ConvertFrom-Json) | ForEach-Object { $_ } | Where-Object title -eq 'proteus tag signing').key
if (-not $key) { throw "proteus tag signing key not found on GitHub" }
"proteus namespaces=`"git`" $key" | Set-Content -Encoding ascii "$HOME\.config\proteus\allowed_signers"
$key | Set-Content -Encoding ascii "$HOME\.config\proteus\maintainer.pub"
ssh-keygen -lf "$HOME\.config\proteus\maintainer.pub"
git -C "$HOME\proteus" config gpg.ssh.allowedSignersFile "$HOME/.config/proteus/allowed_signers"
```

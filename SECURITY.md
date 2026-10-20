# Security policy

Thermite runs code that AI models write, so its design keeps that code away from the judge, the keys and the other agents. If you find a way past that design, please tell the maintainers privately, as this page says.

## Supported versions

Thermite is at version 0.x. Only the latest release gets security fixes: a fix ships in a new release, and older releases get none. Before the first release, fixes go to the development branch.

| Version | Security fixes |
| --- | --- |
| The latest 0.x release | Yes |
| Any older release | No |

## Report a problem

Report it privately, through GitHub's private vulnerability reporting:

1. Open the repository's [**Security** tab](https://github.com/iammrduncan/thermite/security), then **Report a vulnerability**. Or go straight to the [form](https://github.com/iammrduncan/thermite/security/advisories/new).
2. Give the report a short title, and describe the problem as the next section says.

Only you and the maintainers see the report, and you can talk with them there. Don't open a public issue or pull request about it, and don't post it on Discord.

## What counts

A security problem is a way past one of Thermite's design rules. For example:

- code that an agent wrote, or a change that the judge runs, can read or change the judge's files, the ledger, a kit, a secret file or another lane's work, or can change a measurement or a verdict;
- a command or a report that was forged, replayed or changed on the way is accepted;
- a token can do more than its role allows, or a route works without the token it needs;
- a secret reaches a place it should not: a log, an event, an export, an agent, or a rig that does not use it;
- someone can get into control, a rig, or a machine or cluster that control manages.

Some limits are part of the current design, such as this one: under compose, the agents' code can reach your local network. [Known limits](docs/_site/src/content/docs/reference/known-limits.md) lists them, and [the security model](docs/_site/src/content/docs/explanation/security-model.md) says what each part of Thermite can reach and what it trusts. A way past what those pages say is a security problem.

## What to put in a report

- **What the problem is:** which part it is in (control, the harness, the supervisor, an image, the command line or a kit), and what someone could do with it.
- **Which Thermite:** the release, or the commit you built from (`git log -1 --oneline`).
- **Where it runs:** under compose (with your container engine and compose tool), on a machine that control set up over SSH, on a Kubernetes cluster, or in a RunPod test pod; and the operating system.
- **How to make it happen:** the steps, with a proof of concept if you have one.
- **What shows it:** logs or output, with your own keys, host names and addresses removed.
- **Who else knows:** whether you told anyone else, and whether and how you want to be named when the fix is published.

Never send a real key, token or password.

## What happens next

1. The maintainers confirm in the report that they got it. They are a small team, and they answer as soon as they can.
2. They check the problem, and tell you whether they accept it as a security problem, and why.
3. They make a fix in private, and may ask you to check it.
4. The fix ships in a new release. The maintainers then publish a security advisory on GitHub, which names you unless you ask them not to. They can ask GitHub for a CVE number for it.

Please keep the problem private until the advisory is published.

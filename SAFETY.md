# Safety

English | [中文](SAFETY.zh.md)

> Inherited text: this file descends from the upstream DeepSeek Harness SAFETY.md and speaks about "the project" in both senses — the harness and the OpenBrowserHarness extension built on it.

## Experimental status

OpenBrowserHarness is experimental developer-preview software. It has not undergone a security audit and must not be treated as secure or production-ready.

The project can execute model-generated code and commands, load third-party plugins, and access the network, processes, credentials, and files made available to it. Incorrect model output, defects, misconfiguration, malicious input, or untrusted plugins may damage the host computer, modify or delete files, disclose data or credentials, or cause other unintended effects.

## Browser automation risks (extension)

The extension drives your **real browser** — the same profile, cookies, and logins you use every day. That adds risks beyond the desktop list above:

- **Irreversible actions on sites where you are signed in.** Pointed at a shopping, banking, or social page, the agent can place orders, publish posts, or send messages as you. Approval prompts reduce this, but they are only as careful as the person clicking them.
- **Target-site terms of service.** Automated interaction may violate a website's terms even when each action is individually harmless. You are responsible for how you use it.
- **Visible `chrome.debugger` banner.** Chrome/Edge shows "started debugging this browser" while the automation is attached; if that banner disappears unexpectedly, close the page.
- **Prompt content leaves the machine.** Page content the agent reads (and anything you type) is sent to the model provider you configured. Nothing else is collected — there is no telemetry — but treat everything the agent sees as disclosed to that provider.

Practical rules: start on throwaway pages, keep the permission tier at ask-per-action until a task is trusted, prefer a separate browser profile over your daily one, and export the session log to audit what actually happened.

## Sandbox limitations

Sandboxing, approval prompts, and permission controls can reduce risk, but they do not guarantee isolation or prevent damage. Even correctly enforced restrictions cannot protect resources that the project is allowed to access.

Do not rely on OpenBrowserHarness as the sole security control for untrusted workloads.

## Responsible use

- Run the project with the least privileges and access required.
- Prefer a disposable virtual machine, container, or dedicated environment.
- Keep backups of files that the project can access.
- Do not expose sensitive credentials or data unless you accept the risk.
- Review plugins, configuration, and proposed commands before allowing them to run.

## No warranty or liability

Use OpenBrowserHarness at your own risk. The software is provided without warranty under the [MIT License](LICENSE). To the maximum extent permitted by applicable law, the authors and copyright holders are not responsible for damage to computers, loss or disclosure of data, loss of files, or other harm arising from use of the project.

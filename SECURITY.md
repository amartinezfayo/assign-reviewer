# Security Policy

## Supported Versions

This repository has no release series. Security fixes land on the `main` branch, and a repository that uses the actions picks them up by updating the commit it pins.

## Reporting a Vulnerability

The actions in this repository run with a token that can write issues and pull requests in every repository that opts in, so please do not report a vulnerability in a public issue or pull request.

If you've found a vulnerability or a potential vulnerability in these actions please let us know at <security@spiffe.io>. We'll send a confirmation email to acknowledge your report, and we'll send an additional email when we've identified the issue positively or negatively.

The properties the actions rely on to stay safe are described in the [security model](README.md#security-model).

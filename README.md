# thermite

Autoresearch harness that burns through everything.

Thermite runs many research campaigns at once across a fleet of machines. Agents propose changes, and code they cannot touch measures, judges and keeps the best. It supports three kinds of campaign:

- hill climbing a metric under guard rails;
- working toward goals until they are reached or shown impossible;
- researching a topic for a set time.

One dashboard shows and steers all of it, with an API and MCP. It runs under docker-compose or podman-compose; the same images run on Kubernetes, with manifests to come.

**Status:** v1 is in development.

## Start here

- [Quick start](docs/quickstart.md): Thermite on one machine. Build and start the stack, let the rig check itself, connect a model, run a campaign on your own project, and take the result.
- [Documentation](docs/README.md): how it works, campaign modes, judging, kits and every setting.

You need Node.js 22.19 or later, and Podman or Docker with compose. A model endpoint (OpenAI-compatible, with tool calling) is needed for the agents; the judge works without one.

## License

[MIT](LICENSE)

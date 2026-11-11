# Leap360 AI SDKs

**Access control for AI agents.** Leap360 checks every tool call your agents make before it runs: allow it, hold it for a person, or block it, and stop every agent at once with Stop all.

This repository holds the open-source SDKs (Apache-2.0):

| Language | Folder | Install |
| --- | --- | --- |
| TypeScript / JavaScript | [`typescript/`](typescript) | `npm install leap360` |
| Python | [`python/`](python) | `pip install leap360` |

## Quick start (TypeScript)

```ts
import { Leap360 } from 'leap360';

const leap = new Leap360({ apiKey: process.env.LEAP360_API_KEY, serviceName: 'support-bot' });
const refund = leap.wrapTool('refund_customer', async (args) => realRefund(args));
```

Get an API key at [leap360.ai](https://leap360.ai). New projects start in Watch mode, so nothing is blocked until you turn blocking on.

## Links

- Website and console: https://leap360.ai
- npm: https://www.npmjs.com/package/leap360
- PyPI: https://pypi.org/project/leap360

## License

Apache-2.0. See [LICENSE](LICENSE).

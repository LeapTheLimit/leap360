# Contributing to Leap360

Thanks for helping. A few things make reviews quick:

1. **Open an issue first** for anything larger than a small fix, so we can agree on the approach.
2. **Keep pull requests focused**: one change per PR, with a short description of what and why.
3. **Run the tests** before you push:
   - TypeScript: `cd typescript && npm install && npm run build && npm test`
   - Python: `cd python && pip install -e . && python -m pytest`
4. **Never commit secrets.** Use `LEAP360_API_KEY` from the environment in examples and tests.

By contributing you agree that your contribution is licensed under Apache-2.0.

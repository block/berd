# @aaif/goose-sdk

TypeScript client library for the Goose Agent Client Protocol (ACP).

This package provides:
- TypeScript types and Zod validators for Goose ACP extension methods
- A client for communicating with the Goose ACP server

## Installation

```bash
npm install @aaif/goose-sdk
```

The native `goose` binaries are distributed as optional dependencies
and will be automatically installed for your platform.

## Development

### Prerequisites

- Node.js 18+
- Rust toolchain
- (Optional) Cross-compilation toolchains for building all platforms

### Building

```bash
# Regenerate schema JSON from the pinned upstream Goose backend AND rebuild TypeScript
../scripts/regenerate-sdk-schema.sh

# Regenerate layer-2 codegen (types.gen.ts / zod.gen.ts / client.gen.ts) from
# the checked-in schema JSON, then compile with tsc
npm run build

# Compile with tsc only (no layer-2 codegen, no schema regen)
npm run build:ts

# Build native binary for current platform
npm run build:native

# Build native binaries for all platforms
npm run build:native:all
```

### Local Development with npm link

To use this package locally in another project (e.g., `@aaif/goose`):

```bash
# In ui/sdk
npm run build
npm link

# In ui/text (or another project)
npm link @aaif/goose-sdk
```

### Schema Generation

The TypeScript types are generated from Rust schemas defined in `crates/goose`
in the upstream Goose backend pinned by `goose-backend.lock.json`. The pipeline:

1. `scripts/ensure-local-goose.sh` syncs the managed Goose checkout to the pinned commit
2. `cargo build -p goose --bin generate-acp-schema` builds the generator
3. The generator produces `sdk/schema/acp-schema.json` and `sdk/schema/acp-meta.json`
4. `@hey-api/openapi-ts` generates TypeScript types and Zod validators
5. A typed client is emitted to `src/generated/client.gen.ts`

To regenerate everything from the pinned backend:

```bash
# From the repo root
./scripts/regenerate-sdk-schema.sh

# Or, when bumping the backend pin in the same step:
just bump-goose <ref-or-sha>
```

## Native Binary Packages

Platform-specific npm packages for the `goose` binary are located in
`ui/goose-binary/`:

| Package | Platform |
|---------|----------|
| `@aaif/goose-binary-darwin-arm64` | macOS Apple Silicon |
| `@aaif/goose-binary-darwin-x64` | macOS Intel |
| `@aaif/goose-binary-linux-arm64` | Linux ARM64 |
| `@aaif/goose-binary-linux-x64` | Linux x64 |
| `@aaif/goose-binary-win32-x64` | Windows x64 |

These are published separately from `@aaif/goose-sdk`.

### Building Native Binaries

```bash
# Build for current platform
npm run build:native

# Build for all platforms (requires cross-compilation toolchains)
npm run build:native:all

# Build for specific platform(s)
npx tsx scripts/build-native.ts darwin-arm64 linux-x64
```

## Publishing

Publishing is handled by GitHub Actions. See `.github/workflows/publish-npm.yml`.

For manual publishing:

```bash
# From repository root
./ui/scripts/publish.sh --real
```

This will:
1. Build and publish `@aaif/goose-sdk`
2. Publish all native binary packages
3. Publish `@aaif/goose` (which depends on the above)

## Usage

```typescript
import { GooseClient } from "@aaif/goose-sdk";

const client = new GooseClient({
  // ... configuration
});

// Use the client
const result = await client.someMethod({ ... });
```

See the [main documentation](../../README.md) for more details.

# sq

`sq` is Block's Common Toolchain and provides access to a modular suite of commandline tools.

info

`sq` is preinstalled on Block laptops for all engineers.

(If not: run `brew install square/formula/sq` or refer to [sq](https://github.com/squareup/sq))

You can list available commands by typing `sq` at the command line. Example:

```
$ sqUSAGE   sq <command> [<args>]COMMANDS   apps:     Configure backend services to run locally   kochiku   Find or start a Kochiku build and view it in a browser   packs:    Add or remove optional packs of commands   pair      Get or set your current pairing session   ssh       Connect to services in Block's datacenters   update    Update sq and all installed packs
```

You can read docs for any command by typing `sq help <command>` or by visiting the commandline reference.

tip

`sq packs` will show you additional collections of commands and you can install them with `sq packs add`.

--- 

# Architecture

Like [oclif](https://oclif.io/) and [Cobra](https://github.com/spf13/cobra), `sq` is [a framework](https://github.com/square/exoskeleton#exoskeleton) that provides consistent menus, help pages, tab-completion, and suggestions. `sq` also installs and auto-updates commands on-demand and instruments their [reliability, performance, and usage](https://go/sq-dash). But `sq` differs from other CLI frameworks in that subcommands of `sq` aren't objects in TypeScript or Go but executables external to it in predictable locations.

Each subcommand maps to a standable and separate executable, which allows the subcommand to be implemented in different languages and be released on different schedules.

`sq` provides a common entrypoint as a framework for commandline tools.

## Example with `cowsay`

If `cowsay` is an executable, it will appear as a subcommand of `sq` if it is located in:

1.  `./sqbin` where `.` is the current working directory or any of its ancestors
2.  `/opt/homebrew/etc/sqbin` or `/usr/local/etc/sqbin`

In the following scenario

```
$ cd /Users/jack/Development/java$ sq cowsay
```

`sq` will look for an executable named `cowsay` in these paths, in order; and it will stop at the first match:

1.  `/Users/jack/Development/java/sqbin/cowsay`
2.  `/Users/jack/Development/sqbin/cowsay`
3.  `/Users/jack/sqbin/cowsay`
4.  `/Users/sqbin/cowsay`
5.  `/sqbin/cowsay`
6.  `/opt/homebrew/etc/sqbin/cowsay`
7.  `/usr/local/etc/sqbin/cowsay`

Nested commands can be represented with subdirectories. For example, `sq mysql pull` maps to a path like `/opt/homebrew/etc/sqbin/mysql/pull`.

[discovery.go](https://github.com/square/exoskeleton/blob/main/discovery.go) in [https://github.com/square/exoskeleton](https://github.com/square/exoskeleton) implements `sq`'s requirements for command discovery. `sq` uses exoskeleton for command discovery [here](https://github.com/squareup/sq/blob/main/internal/sq/sq.go#L58).

---

# Metadata

`sq` uses 5 pieces of metadata about each command (or module):

-   **name** — (required) for `sq` to identify a command and display it in menus
-   **summary** — (required) a short description (80 characters max) for `sq` to display in menus
-   **help** — (required) documentation for `sq` to display in response to `sq COMMAND -h`, `sq COMMAND --help`, or `sq help COMMAND`
-   **version** — (optional) a version string (X.Y.Z) for `sq` to display in response to `sq COMMAND --version` or `sq version COMMAND`
-   **formula** — (optional) the Homebrew formula that packages a command for `sq` to check for updates and to report with metrics

For commands installed with Homebrew, **version** and **formula** are extracted from their keg.

The [Integration Guide](/docs/tools/sq-cli/guides/integration) describes how to write new commands for `sq`.
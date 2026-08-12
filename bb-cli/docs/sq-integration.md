# How to integrate a commandline tool with sq


## Why sq?

`sq`'s [job](https://go/common-toolchain) is to make the long tail of CLIs at Block discoverable and observable without locking CLI authors into a single language, framework, or repo.

### Hello World

Paste the following into your terminal to define `sq echo`:

```
cd ~mkdir sqbinecho '#!/usr/bin/env sh# SUMMARY: Writes its arguments to stdout# HELP: USAGE#    sq echo [string...]## EXAMPLES#    sq echo hello worldecho "$@"' > sqbin/echochmod +x sqbin/echo
```

Now if you type `sq`, you'll see `echo` in the list of commands with its summary text:

```
$ sqUSAGE   sq <command> [<args>]…COMMANDS IN ~/sqbin   echo     Writes its arguments to stdout
```

If you type `sq help echo`, you'll see its help text:

```
$ sqUSAGE   sq echo [string...]EXAMPLES   sq echo hello world
```

And if you type `sq echo hello world`, you'll see "hello world".

### Summary and Help

If you write your command in a compiled language (like Go), make sure that it responds to two flags, `--summary` and `--help`, with the appropriate text. [Here's an example](https://github.com/squareup/sq-ssh/blob/d9f9a72ae24e5feb43502d47255be152c4954a2d/main.go#L254-L264) from `sq ssh`.

If you compose your command as a shell script, you may either respond to `--summary` and `--help` or may include the SUMMARY and HELP magic comments after the shebang (`#!`) like in the [example above](#hello-world).

Modules (menus of nested commands) need only a SUMMARY; and that's supplied as a magic comment in a file named `.sq-module`. [Here's an example](https://github.com/squareup/sq-sentry/blob/c6c72fe63b82b02ad8689ebd0e6626f9672a9c0c/sqbin/sentry/.sq-module) from `sq sentry`.

[examples/bash](https://github.com/squareup/sq/tree/9883e5f84b38d037909690dbf00f82469d8e14a6/examples/bash) and [examples/go](https://github.com/squareup/sq/tree/9883e5f84b38d037909690dbf00f82469d8e14a6/examples/go) are sample CLIs implemented this way.

### Subcommands

To integrate a command line tool that already supports its own subcommands requires a different approach.

Your CLI should:

1.  Have the extension `.exoskeleton`
2.  Respond to `--describe-commands` by printing JSON to standard output describing the structure of the tool.

`sq util` is an example. Typing `sq util` will list the standard menu with four subcommands, but all of the subcommands live in a binary named `util.exoskeleton`:

```
$ sq which util lint/opt/homebrew/etc/sqbin/util.exoskeleton$ sq which util usage/opt/homebrew/etc/sqbin/util.exoskeleton
```

And you can invoke `util.exoskeleton` with `--describe-commands` to see the structure of the `util` CLI:

```
$ $(sq which util) --describe-commands{  "name": "util",  "summary": "Back-of-House utilities for sq",  "commands": [    {      "name": "discover",      "summary": "Describe the commands that sq would discover in given paths"    },    {      "name": "kegs",      "summary": "List the installed kegs that provide sq commands"    },    {      "name": "lint",      "summary": "Lint commands in a given path"    },    {      "name": "usage",      "summary": "List available commands along with their usage"    }  ]}
```

[examples/go+kong](https://github.com/squareup/sq/tree/9883e5f84b38d037909690dbf00f82469d8e14a6/examples/go%2Bkong) is an example of a Kong CLI that implements this `--describe-commands` flag.

### Conventions

#### Conventions for SUMMARY text

-   Keep the SUMMARY text short — under 80 characters
-   It should be only a single sentence but **_not_** end with a period
-   It should start with an imperative verb
    
    ###### GOOD
    
    ```
    ssh       Connect to services in Block's datacenters
    ```
    
    ###### BAD
    
    ```
    ssh       Connects to services in Block's datacenters
    ```
    
    ```
    ssh       This lets you connect to services in Block's datacenters
    ```
    

#### Conventions for HELP text

-   Each section of the Help text should have its own heading and indented content
-   Headings should be in all caps (`sq` will automatically make these Bold White (`\e[1m`))
-   Indentation is always a multiple of 3 spaces
-   Make USAGE the first section
-   If applicable, include an OPTIONS section to document any flags your CLI accepts
-   Include an EXAMPLES section
-   Make SUPPORT the last section
    -   Name the Slack channel where users can reach out for support
    -   Optionally, identify the repo where pull requests are welcome

[Here's an example](https://github.com/squareup/sq-ssh/blob/d9f9a72ae24e5feb43502d47255be152c4954a2d/main.go#L25-L67) from `sq ssh`.

### Distributing a Pack

You can distribute a pack of commands for `sq` with a Homebrew Formula.

We recommend structuring your project so that executables are in `./sqbin`. You can author shell scripts directly in this path or compile binaries to it. There are two advantages to this:

1.  It yields a better local development experience. Since `sq` [discovers](/docs/tools/sq-cli/concepts/architecture) commands `./sqbin` first, while you're iterating on your commands, you'll be able to run them with `sq`.
2.  It allows your Homebrew Formula to be incredibly minimal (see below).

If you have more than one executable, group them into a subdirectory within `sqbin` and add a `.sq-module` file. For example, to ship `sq sentry search` and `sq sentry events` as commands and `sq sentry` as a menu that lists them, you would structure your project as follows:

```
$ tree -a sqbinsqbin└── sentry    ├── .sq-module    ├── events    └── search
```

If you structure your project this way — with executables in `sqbin` — your Homebrew Formula will just need to install that path into its keg. Homebrew will take care of symlinking everything under `etc` into `/usr/local` or `/opt/homebrew`, where `sq` will [discover](/docs/tools/sq-cli/concepts/architecture) it.

If our [Hello World example](#hello-world) were in a repo named **sq-echo**, a minimal formula to install it would look like this:

```
class SqEcho < Formula  version "1.0.0"  url "https://github.com/squareup/sq-echo.git", tag: version.to_s  # This formula publishes a pack of `sq` commands  # The following metadata governs how it appears in `sq packs list`  @sq_pack = { name: "echo", desc: "Writes its arguments to stdout" }  def install    (prefix/"etc").install "sqbin"  endend
```

(In the future, we intend to generate this file automatically.)

### Completions

`sq` supports tab-completion on command names. If the user attempts to tab-complete on a command's arguments or flags, `sq` will invoke the command with `--complete`.

> ### Illustration
> 
> If the user types
> 
> ```
> $ sq pair jack rw<tab>
> ```
> 
> then the [Bash](https://github.com/squareup/sq/blob/9883e5f84b38d037909690dbf00f82469d8e14a6/etc/bash-completion.sh) / [Zsh](https://github.com/squareup/sq/blob/9883e5f84b38d037909690dbf00f82469d8e14a6/etc/zsh-completion.sh) completion scripts will execute:
> 
> ```
> $ sq complete pair jack rw
> ```
> 
> and `sq` will invoke `pair` like this:
> 
> ```
> $ $(sq which pair) --complete -- jack rw
> ```
> 
> Its output looks like:
> 
> ```
> rwurwaggonerrwiggintonrwallsrweatherlyrwhiterwoodsrwidyanti:4
> ```
> 
> This output has two parts:
> 
> 1.  A list of suggestions for completing the argument `rw` (one per line)
> 2.  A directive prefixed with `:`

When `sq` executes a subcommand with `--complete`, if it exits nonzero or produces output that isn't parsable by [the shellcomp package](https://github.com/square/exoskeleton/tree/main/pkg/shellcomp), `sq` will tell the shell not to perform any completions.

To support completions, a command just needs to respond to the flag `--complete` and write suggestions to standard output, followed by a [directive](https://github.com/square/exoskeleton/tree/main/pkg/shellcomp#directives). ([Here is a sample Ruby implementation](https://github.com/squareup/sq-pair/pull/1/files).)

Go projects may import the package `"github.com/square/exoskeleton/pkg/shellcomp"`.

### Metrics

`sq` automatically collects usage metrics for your command. To see a dashbaord for `sq echo`, navigate to [https://square.cloud.looker.com/dashboards/16914](https://square.cloud.looker.com/dashboards/16914) and select `sq echo` from the **Command** filter.

You'll be able to see your CLI's

-   **Failure Rate** and the breakdown of exit codes
-   **Daily Active Users** and how sticky your users are (how frequently they use the tool)
-   **CSAT**, solicited by [@csat-bot](https://github.com/squareup/csat-bot#csat-bot)
-   and more

If you'd like to filter your usage by application-specific dimensions, your CLI can send additional labels to `sq` and you can select one or more labels with the **Labels** filter in that dashboard.

#### Sending Additional Labels

`sq` will give a value to the environment variable `SQ_METRICS_PIPE` when it invokes your subcommand. The variable identifies a named pipe. The pipe accepts one or more messages, separated by newlines. (A final trailing newlines is required.) Each message begins with a directive. At this time, the only support directive is `LABELS` which expects to be followed with a whitespace-separated list of labels to add to the usage metric.

###### Bash

```
echo "LABELS foo bar" >> "$SQ_METRICS_PIPE"
```

###### Ruby

```
File.open(ENV["SQ_METRICS_PIPE"], "a") { |f| f.write "LABELS app:cluster-zkserver app:haas app:panfake app:fidelius app:bletchley app:trunk\n" }
```

###### Go

```
if f, err := os.OpenFile(os.Getenv("SQ_METRICS_PIPE"), os.O_APPEND|os.O_WRONLY, 0644); err != nil {	log.Fatal(err)} else {	f.Write([]byte("LABELS infra:ski\n"))	f.Close()}
```

### Best Practices

#### Exit Codes

Use [semantic exit codes](https://github.com/square/exit/#the-codes) to get [more value](https://developer.squareup.com/blog/command-line-observability-with-semantic-exit-codes/) out of `sq`'s dashboards.

In most languages, if your command line tool crashes, it sets its exit status to 1 If it exits naturally, it sets its exit status to 0. You can get more value out of your telemetry (for example, you can bisect user errors and system errors) by explicitly setting exit statuses when you exit early. For example, if the user has entered an invalid input and you've displayed some kind of validation error, exit 80 (Usage Error). If it makes an API call to a server and the server returns 504 or 503, exit 101 (Unavailable).

#### See also

-   [the recommended way of structuring a project](#distributing-a-pack)
-   the conventions for [summary](#conventions-for-summary-text) and [help](#conventions-for-help-text) text
-   [clig.dev](https://clig.dev/), Command Line Interface Guidelines
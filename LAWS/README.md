# Architectural laws

Architectural laws define Berd's required product and user experience behavior.
They are the source of truth for what the product does, independent of how the
current implementation is structured.

The key words **MUST** and **MUST NOT** in this directory are to be interpreted
as described in [BCP 14](https://www.rfc-editor.org/info/bcp14)
([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they
appear in all capitals.

## Rules for laws

- Laws MUST describe behavior that is observable in the product.
- Laws MUST specify product or user experience behavior, not implementation details.
- Laws MUST express deliberately established, durable product invariants or
  boundaries that should remain authoritative as feature designs change.
- Feature requirements, workflows, fields, formats, and other changeable feature
  policy MUST NOT be written as laws merely because they are observable or settled.
- A behavior that qualifies as a law candidate MUST NOT be added unless the product
  explicitly chooses to canonize it as an enduring constraint.
- Laws MUST use **MUST** or **MUST NOT** for normative requirements.
- Each law MUST state one requirement.
- Laws MUST be concise and independently understandable.
- Code and tests MUST conform to the laws.
- Product decisions that are not settled MUST NOT be written as laws.

## Working with laws

Agents and contributors MUST read the relevant files in this directory before
planning, implementing, or reviewing behavior changes. Pull requests that change
observable behavior MUST identify the affected laws and MUST update the code,
tests, or laws so they agree.

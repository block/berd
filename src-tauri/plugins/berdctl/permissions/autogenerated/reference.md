## Default Permission

Default permissions for the app control plugin (the loopback HTTP broker for
the berdctl CLI). Grants the main window access to the broker lifecycle,
timeout, and bridge-result commands.

#### This default permission set includes the following:

- `allow-start`
- `allow-stop`
- `allow-status`
- `allow-set-timeouts`
- `allow-submit-result`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`berdctl:allow-set-timeouts`

</td>
<td>

Enables the set_timeouts command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:deny-set-timeouts`

</td>
<td>

Denies the set_timeouts command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:allow-start`

</td>
<td>

Enables the start command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:deny-start`

</td>
<td>

Denies the start command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:allow-status`

</td>
<td>

Enables the status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:deny-status`

</td>
<td>

Denies the status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:allow-stop`

</td>
<td>

Enables the stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:deny-stop`

</td>
<td>

Denies the stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:allow-submit-result`

</td>
<td>

Enables the submit_result command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`berdctl:deny-submit-result`

</td>
<td>

Denies the submit_result command without any pre-configured scope.

</td>
</tr>
</table>

# Remote Control Setup

Research Agent can expose the workspace running on your home or office computer to a phone, tablet, or another computer. Projects, agents, files, and notebook runtimes continue to run on the host computer; the remote device only displays and controls the Research Agent web interface.

Remote control uses the separately installed [Remote.It](https://www.remote.it/download) desktop and mobile applications. Research Agent does not bundle Remote.It, create a Remote.It account, or sign in for you.

## Before you begin

You need:

- Research Agent running on the computer that stores your projects.
- The Remote.It desktop application installed on that computer.
- A Remote.It account signed in on the desktop application.
- For App access, the Remote.It mobile application signed in to the same account.

The host computer must remain powered on, connected to the internet, and running both Research Agent and the Remote.It agent.

## 1. Add the host computer to Remote.It

This is a one-time account authorization step.

1. Open the Remote.It desktop application and sign in.
2. Select the **+** button.
3. Choose **This system**.
4. Confirm **Add Device**.
5. Return to Research Agent.

Research Agent cannot reuse the desktop application's sign-in token to authorize this Device automatically. After the Device has been added once, Research Agent can create and maintain its own services.

## 2. Open Remote Control

In Research Agent, open:

**Settings → Remote Control**

The page offers three modes:

| Mode               | Best for                                                         | Verification                                                                                    |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Off**            | Local use only                                                   | Remote requests are blocked by Research Agent.                                                  |
| **App access**     | Regular access from the signed-in Remote.It mobile app           | Every new browser session completes Research Agent two-step verification with a six-digit code. |
| **Browser access** | Access from any modern browser using a persistent URL or QR code | Every new browser completes Research Agent two-step verification with a six-digit code.         |

The two remote modes use separate managed services:

- **Research Agent Remote** is the private App access service.
- **System Service** supplies the persistent public Browser access URL.

Keeping these services separate prevents Browser access from changing the behavior of the private App connection.

## 3. Enable App access

1. Select **App access**.
2. If Research Agent reports that setup is incomplete, select **Detect and set up**.
3. Approve the operating-system prompt if service creation or repair requires administrator access.
4. Wait until the page reports **Connected**.
5. Open the Remote.It mobile app and sign in to the same account.
6. Select the host computer, then select **Research Agent Remote**.
7. Select **Connect** or **Launch**.
8. Compare the six-digit code with the request shown in **Pairing requests**.
9. Approve the request from the Research Agent desktop window or an already trusted browser.
10. Choose **Allow once** for temporary access or **Always trust this browser** for later visits to the same remote address.

Remote.It account access opens the private route, but it is not an Research Agent credential. The six-digit confirmation prevents a local process from impersonating that route with forged HTTP headers.

## 4. Enable Browser access

1. Select **Browser access**.
2. If needed, select **Detect and set up** and approve the operating-system prompt.
3. Wait until the page reports **Connected** and shows the persistent browser link.
4. Open the link with **Open**, copy it to another device, or scan the displayed QR code.
5. On the new browser, compare its six-digit code with the request shown in **Pairing requests**.
6. Approve the request from the Research Agent desktop window or from an already trusted browser.
7. Choose **Allow once** for temporary access or **Always trust this browser** for later visits to the same remote address.

Browser trust belongs to the browser profile, not to the physical device. Private browsing, cleared site data, a different browser, or a different browser profile requires verification again.

### Manage trusted browsers

The **Trusted browsers** section lists browser profiles with permanent access through either remote mode. Revoke an entry to deny it on its next HTTP request or WebSocket reconnect.

The **Pairing requests** section lists browsers currently waiting for two-step verification. Approve only when the six-digit code matches the code on the requesting browser.

## Switch modes or turn access off

- Switching between **App access** and **Browser access** reuses the existing managed services whenever they are healthy.
- Select **Off** to block remote access locally. Research Agent keeps the provider configuration so a later restart does not needlessly recreate services.
- Closing Research Agent, shutting down the host computer, or losing the host network connection makes the workspace unavailable remotely.

## Troubleshooting

### Remote.It is installed but Research Agent says sign-in is required

Open the Remote.It desktop application, finish signing in, and select **Detect and set up** again.

### Research Agent asks you to add a Device

In Remote.It, choose **+ → This system → Add Device** once. Do not use a claim code for the host computer. Return to Research Agent and select **Detect and set up**; Research Agent will create both managed services automatically.

### Setup asks for administrator approval

Administrator approval is requested only when an Research Agent service must be created or repaired. Repeated mode switches should reuse the healthy services and should not recreate them.

### The provider is still switching its background service mode

Wait a few seconds, then select **Detect again**. Do not add the Device again and do not create a service manually.

### App access opens the wrong service

Select **Research Agent Remote** in the mobile app. **System Service** is reserved for Browser access.

### Remote access shows a verification page again

The browser profile is not currently trusted. Complete the six-digit verification, or verify that cookies and site data were not cleared.

### The remote page loads slowly or stays blank

Keep Research Agent and the Remote.It agent running on the host, verify that the host has a stable network connection, then reconnect or refresh. If the problem continues, return to **Settings → Remote Control** and select **Detect again** for the active mode.

## Security notes

- App access relies on the signed-in Remote.It account and the private service created for Research Agent, then requires Research Agent's own browser verification before workspace access.
- Browser access publishes a persistent endpoint and uses the same secure-cookie, trusted-browser, and revocation controls.
- Provider `Host` and `Origin` headers identify an expected route but never authenticate a request.
- Do not share a browser pairing code with another person.
- Revoke browsers you no longer use.
- Select **Off** when remote access is not needed.

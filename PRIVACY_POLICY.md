# Privacy Policy for BSync

Effective date: 2026-08-25

## Overview

BSync is a browser extension for synchronizing page focus and media playback between users in a shared browser room.

This Privacy Policy explains what data BSync collects or processes, how the data is used, and when the data may be shared.

## Single purpose

BSync's single purpose is to let users create or join a shared room and synchronize the selected browser page and media playback state with other room participants.

The extension provides a browser popup and an on-page overlay for room status, connection status, media synchronization status, and follow/detach controls.

## Data collected or processed by BSync

BSync processes only the data required for its synchronization features.

### Browser page data

BSync may process the following page data for the selected or active page:

- Page URL
- Page title
- Hostname
- Document loading state
- Page visibility state

This data is used to identify the page selected for synchronization and to display the current room page in the extension UI.

### Media playback data

BSync may process the following media playback data from video or audio elements on the selected room page:

- Media identifier or media source
- Current playback time
- Duration
- Paused or playing state
- Playback rate
- Volume
- Muted state
- Last update time

This data is used to synchronize playback between room participants.

The protocol sends only playback metadata. Its media fields are `mediaKey`, page
`url`, `paused`, `currentTime`, `duration`, `playbackRate`, `updatedAt`, and a
message sequence number (`seq`). Volume and muted state may be processed locally
by the extension but are not included in protocol v2 synchronization messages.
BSync does not capture or transfer audio, video, screen, camera, microphone, or
other media streams or media file contents.

### Invite and reconnect data

An invite URL fragment contains a protocol version, synchronization server URL,
room identifier, random invite token, and expiration time. The fragment is
processed by the BSync app and extension; browsers do not send URL fragments in
HTTP requests. The room identifier and invite token are sent to the configured
synchronization server when a guest joins. Server-issued invites expire after 24
hours.

The server also issues each participant a random resume token. The extension
keeps the room identifier, server URL, invite expiration, invite token when
needed for joining, resume token, and last received sequence number in
browser-managed session storage. The server holds the corresponding in-memory
room/session metadata. Disconnected host and guest sessions have a 30-second
reconnect grace period, after which their resumable session is removed (and a
host timeout closes the room). Explicitly leaving removes the applicable room
session immediately.

### Extension state and settings

BSync stores extension state and settings locally in the browser, including:

- Server URL
- Room identifier
- Locally generated client identifier
- Display name
- Room role
- Overlay visibility
- Overlay position
- Compact mode setting
- Connection status
- Synchronization status
- Recent extension activity

This data is required so the popup, background script, and page overlay can share the same state and continue working after the popup is closed or the browser is restarted.

Recent activity is an application log stored locally in browser extension
storage and shown in Settings. It contains up to 20 status labels and timestamps
and can be cleared by the user. BSync does not send this activity log to the
synchronization server.

### Room synchronization messages

When room synchronization is enabled, BSync may send synchronization messages through the configured WebSocket server. These messages may include:

- Protocol version, message identifier, timestamp, and sequence numbers
- Room identifier, invite token when joining, or resume token when reconnecting
- Display name
- Room role
- Selected page metadata
- Media playback state
- Presence information
- Ping or latency information

These messages are used only to deliver synchronization functionality between room participants.

The BSync synchronization server application logs only its startup/listening
message; it does not intentionally log room messages, invite or resume tokens,
page metadata, or playback metadata. Hosting and network infrastructure may
independently create operational access, security, or error logs containing
connection metadata such as IP address, time, and request details. Those
infrastructure logs are controlled by the operator of the configured server and
its hosting providers, not by the extension's application logging.

## Data BSync does not collect

Apart from BSync's own ephemeral invite and resume bearer capabilities described
above, BSync does not collect or process the following data:

- Passwords
- Cookies
- Account passwords or third-party authentication credentials
- Payment information
- Financial information
- Health information
- Precise location data
- Personal communications such as emails, SMS, or chat messages
- Form inputs
- Full page text content for unrelated purposes

## How BSync uses data

BSync uses data only for the following purposes:

- Creating and joining synchronization rooms
- Displaying room and connection status
- Synchronizing selected page focus
- Synchronizing media playback state
- Showing and controlling the on-page overlay
- Detecting when a user manually detaches from host playback
- Maintaining local extension settings
- Improving reliability of the core synchronization flow

BSync does not use user data for advertising, profiling, creditworthiness, lending decisions, or unrelated analytics.

## Data sharing and recipients

BSync does not sell user data.

BSync does not transfer user data to advertising platforms, data brokers, information resellers, or unrelated third parties.

BSync may share synchronization data only with the following recipients when required for the core synchronization feature:

- The configured WebSocket synchronization server
- Other participants connected to the same synchronization room

If the user enables room synchronization, synchronization messages are sent through the configured WebSocket server so other participants in the same room can receive the selected page metadata and media playback state needed for synchronization.

## Limited Use disclosure

BSync uses user data only to provide or improve its single purpose: browser page and media playback synchronization between participants in a shared room.

The use of information received from Chrome extension APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

BSync does not use or transfer user data for personalized advertising, does not sell user data to third parties, and does not use or transfer user data to determine creditworthiness or for lending purposes.

## Remote code

BSync does not execute remote JavaScript, remote WebAssembly, or dynamically downloaded extension code.

All extension logic is bundled with the extension package. WebSocket messages are treated as synchronization data and are not executed as code. BSync does not use `eval`, `Function`, remote script injection, or dynamic imports from remote URLs.

## Data storage and security

BSync stores extension state and settings locally in the browser using browser extension storage.

Data sent through the configured WebSocket server is used for active room synchronization. BSync is designed to use synchronization messages as transient room state rather than permanent user records.

The reference server keeps rooms, synchronization state, invite credentials,
and resume credentials in memory only; it does not write them to a database.
Invite credentials remain valid for at most 24 hours while the room exists, and
disconnected sessions remain resumable for 30 seconds as described above.

When synchronization is configured to use a remote server, BSync should use secure WebSocket transport (`wss://`) where supported. Local development may use `ws://localhost`.

## User control

Users can control BSync data processing by:

- Disabling the extension
- Leaving the current room
- Turning off synchronization
- Hiding the overlay
- Changing or clearing extension settings
- Removing the extension from the browser

Removing the extension deletes browser-managed local extension storage according to the browser's extension storage behavior.

## Permissions

BSync requests only the permissions needed for its core functionality.

### `storage`

Required to save extension settings and synchronization state locally in the browser.

### `tabs`

Required to detect the active tab, read its title and URL, open or focus the selected room page, and send synchronization commands to the correct tab.

### Host access

Required to inject the BSync overlay into web pages selected by the user and detect video or audio elements for playback synchronization.

## Children's privacy

BSync is not intended to knowingly collect personal information from children. The extension does not request age, identity documents, or personal profile information.

## Changes to this policy

This Privacy Policy may be updated when BSync functionality or data processing changes. Updates should be published in this repository and reflected in the Chrome Web Store listing when required.

## Contact

For privacy questions about BSync, contact the publisher using the contact email listed in the Chrome Web Store developer account.

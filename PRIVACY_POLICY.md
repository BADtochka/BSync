# Privacy Policy for BSync

Effective date: 2026-06-12

## Overview

BSync is a browser extension for synchronizing page focus and media playback between users in a shared browser room.

This Privacy Policy explains what data BSync processes, why it is processed, and how it is used.

## Single purpose

BSync's single purpose is to let users create or join a shared room and synchronize the selected browser page and media playback state with other room participants.

The extension provides a browser popup and an on-page overlay for room status, connection status, media synchronization status, and follow/detach controls.

## Data BSync processes

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

### Extension state and settings

BSync stores extension state and settings locally in the browser, including:

- Server URL
- Room code
- Client identifier
- Display name
- Room role
- Overlay visibility
- Overlay position
- Compact mode setting
- Connection status
- Synchronization status
- Recent extension activity

This data is required so the popup, background script, and page overlay can share the same state and continue working after the popup is closed or the browser is restarted.

### Room synchronization messages

When room synchronization is enabled, BSync may send synchronization messages through the configured WebSocket server. These messages may include:

- Room code
- Client identifier
- Display name
- Room role
- Selected page metadata
- Media playback state
- Presence information
- Ping or latency information

These messages are used only to deliver synchronization functionality between room participants.

## Data BSync does not collect

BSync does not collect or process the following data:

- Passwords
- Cookies
- Authentication credentials
- Payment information
- Financial information
- Health information
- Precise location data
- Personal communications such as emails, SMS, or chat messages
- Form inputs
- Full page text content for unrelated purposes

## How data is used

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

## Data sharing

BSync does not sell user data.

BSync does not transfer user data to third parties except when required for the core synchronization feature. If the user enables room synchronization, synchronization messages are sent through the configured WebSocket server so other participants in the same room can receive page and media playback state.

Room participants may receive the selected page metadata and media playback state needed for synchronization.

## Remote code

BSync does not execute remote JavaScript, remote WebAssembly, or dynamically downloaded extension code.

All extension logic is bundled with the extension package. WebSocket messages are treated as synchronization data and are not executed as code. BSync does not use `eval`, `Function`, remote script injection, or dynamic imports from remote URLs.

## Data storage

BSync stores extension state and settings locally in the browser using browser extension storage.

Data sent through the configured WebSocket server is used for active room synchronization. Retention of relay data depends on the configured synchronization server. BSync is designed to use synchronization messages as transient room state rather than permanent user records.

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

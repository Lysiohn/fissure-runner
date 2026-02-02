# Linux Build Instructions

If you want to build the AppImage yourself (e.g., for Arch Linux, Ubuntu, or Steam Deck), follow these steps.
## However, the OSD is not yet made to be used for Linux, you have to make changes to the OSD yourself to make it work, the log scanner itself etc. should work without problems.

## 1. Prerequisites

Ensure you have **Node.js** (v16 or later) and **Git** installed.

*   **Ubuntu/Debian:**
    ```bash
    sudo apt update
    sudo apt install nodejs npm git
    ```
*   **Arch Linux / SteamOS:**
    ```bash
    sudo pacman -S nodejs npm git
    ```

## 2. Clone & Install

Open a terminal and run:

```bash
git clone https://github.com/Lysiohn/fissure-runner.git
cd fissure-runner
npm install
```

## 3. Build

To build the AppImage without publishing (local build):

```bash
npm run build:linux-local
```

Once finished, you will find the `.AppImage` file in the `dist-installer` folder.

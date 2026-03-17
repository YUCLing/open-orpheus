# Open Orpheus

An open-source implementation of Netease Cloud Music's Orpheus browser host.

## Features

- Cross-platform support
- Open-source

What else do you expect! It just provides a environment for the original client!

## Installation

Uhh, this project is not end-user ready now! Sorry!

## Development

You will need Node and Rust to work with this project.

For root project, everything works just like any other Electron Forge project, but Open Orpheus has some its own native modules, it requires a few more steps to setup.

In the following steps, `yarn` will be used as Node's package manager.

### Setup

#### Build modules

Inside `modules` folder, there are a few native modules that Open Orpheus require to run.

To build them, enter each of submodules' folder. Execute the following commands:

```sh
yarn # Install dependencies
yarn build # Build the module (will build both Rust and Node code)
```

##### (Optional) Linking the modules

If you would like to work with native modules, linking is recommended, so you won't need to reinstall native modules each time you build it.

```sh
# In module's folder
yarn link

# In root project folder
yarn link <MODULE_PACKAGE_NAME_HERE>
```

#### Install dependencies

Simply do this in root project:

```sh
yarn
```

### Resources

This project does not bundle some required resources because they are owned by NetEase. To run this project successfully, you will need to copy the corresponding resources to:

- Working directory (Not packaged)
- Executable's directory (Packaged)

#### `package` folder

This is the most important resource.

It can be found within your installation of official NetEase Cloud Music, e.g. `C:\path\to\your\installation\CloudMusic\package`.

#### `web.pack` file

This is the updated web resources produced by official NetEase Cloud Music, it will be placed in `C:\Users\<YOUR_USERNAME>\AppData\Local\NetEase\CloudMusic\web.pack`. It's necessary if you want the most updated web resources. If it can be found, Open Orpheus will prefer it instead of `orpheus.ntpk`.

This will need to placed along with `orpheus.ntpk`, which is inside `package` folder.

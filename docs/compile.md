## ubuntu

### install npm lastest

Installation Instructions (DEB)

Node.js 22.x:
Using Ubuntu (Node.js 22)

Before you begin, ensure that curl is installed on your system. If curl is not installed, you can install it using the following command:

`sudo apt-get install -y curl`

Download the setup script:

`curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh`

Run the setup script with sudo:

`sudo -E bash nodesource_setup.sh`

Install Node.js:

`sudo apt-get install -y nodejs`

Verify the installation:

`node -v`

### install vscode envirment

`npm install -g yo generator-code`

- if, Response timeout while trying to fetch https://registry.npmjs.org/generator-code (over 30000ms)
then, `npm config set registry https://registry.npmmirror.com`
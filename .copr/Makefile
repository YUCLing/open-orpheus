.ONESHELL:
.PHONY: srpm

srpm:
	# Install minimal dependencies (only Node.js needed for SRPM generation)
	dnf -y install git tar
	# Download and install nvm:
	curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
	# in lieu of restarting the shell
	. "$$HOME/.nvm/nvm.sh"
	# Download and install Node.js:
	nvm install 24
	corepack install
	corepack enable
	# Install project dependencies (only JS, no native build needed)
	pnpm install --frozen-lockfile --ignore-scripts
	# Generate arch-independent SRPM
	pnpm make:srpm --install-tools
	# Copy resulting SRPM to the Copr output directory
	find out/make/srpm -name '*.src.rpm' -exec cp {} $(outdir)/ \;

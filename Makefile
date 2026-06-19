.PHONY: test test-watch build dev clean install-deps

test:          ## run vitest with the coverage gate
	npm test

test-watch:
	npm run test:watch

build:         ## bundle the single-file SPA → dist/sql.html
	npm run build

dev: build     ## build + serve dist/ locally
	npm run dev

install-deps:
	npm install

clean:
	rm -rf dist coverage

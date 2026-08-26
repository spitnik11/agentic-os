# agentic-os tasks — `just` fronts this repo's package.json scripts.
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# show the task list
default:
    @just --list

# install dependencies
setup:
    npm install

setup:
    npm run setup

dev:
    npm run dev

build:
    npm run build

start:
    npm run start

lint:
    npm run lint

typecheck:
    npm run typecheck

test:
    npm run test

test-unit:
    npm run test:unit

test-integration:
    npm run test:integration

test-watch:
    npm run test:watch

index:
    npm run index

doctor:
    npm run doctor

demo-seed:
    npm run demo:seed

demo-reset:
    npm run demo:reset

desktop:
    npm run desktop

desktop-build:
    npm run desktop:build

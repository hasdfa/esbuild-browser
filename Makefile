FLAGS += --bundle
FLAGS += --format=cjs
FLAGS += --outdir=./dist
FLAGS += --target=chrome67
FLAGS += src/index.ts
FLAGS += src/worker.ts
FLAGS += src/service-worker.ts

prod:
	./node_modules/.bin/esbuild $(FLAGS) --define:LIVE_RELOAD=false

dev:
	./node_modules/.bin/esbuild $(FLAGS) --define:LIVE_RELOAD=true --watch --servedir=../../out

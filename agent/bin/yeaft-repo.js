#!/usr/bin/env node
import { runRepoWorkflowCli } from '../repo-workflow-cli.js';

process.exitCode = await runRepoWorkflowCli(process.argv.slice(2));

// Exits before speaking MCP, printing the variable it was passed: the
// engine must not log that value (tests/mcpStdio.test.ts).
process.stderr.write(`boot failed with token ${process.env.STDIO_TEST_PASSED}\n`);
process.exit(1);

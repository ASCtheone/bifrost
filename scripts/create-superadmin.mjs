#!/usr/bin/env node

import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "fs";
import { resolve } from "path";

// Usage: node scripts/create-superadmin.mjs <email> <password> [--sa path] [--project id]
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    email: null,
    password: null,
    serviceAccount: null,
    projectId: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sa" && args[i + 1]) {
      result.serviceAccount = args[++i];
    } else if (args[i] === "--project" && args[i + 1]) {
      result.projectId = args[++i];
    } else if (!result.email) {
      result.email = args[i];
    } else if (!result.password) {
      result.password = args[i];
    }
  }

  return result;
}

async function main() {
  console.log("\n  BIFROST — Create Superadmin\n");

  const { email, password, serviceAccount, projectId } = parseArgs();

  if (!email || !password) {
    console.log("  Usage: node scripts/create-superadmin.mjs <email> <password> [--sa service-account.json] [--project project-id]\n");
    console.log("  Example:");
    console.log("    node scripts/create-superadmin.mjs admin@bifrost.local MyPassword123 --sa ./sa.json --project tt-bifrost-d02f0\n");
    process.exit(1);
  }

  if (password.length < 6) {
    console.error("  Error: Password must be at least 6 characters.\n");
    process.exit(1);
  }

  const appConfig = {};
  if (projectId) appConfig.projectId = projectId;

  if (serviceAccount) {
    const sa = JSON.parse(readFileSync(resolve(serviceAccount), "utf-8"));
    appConfig.credential = cert(sa);
    if (!appConfig.projectId) appConfig.projectId = sa.project_id;
  }

  console.log(`  Project: ${appConfig.projectId ?? "(default)"}`);
  console.log(`  Email:   ${email}\n`);

  initializeApp(appConfig);
  const auth = getAuth();

  try {
    let user;
    try {
      user = await auth.getUserByEmail(email);
      console.log(`  User already exists (uid: ${user.uid})`);
    } catch {
      user = await auth.createUser({
        email,
        password,
        emailVerified: true,
      });
      console.log(`  Created user (uid: ${user.uid})`);
    }

    await auth.setCustomUserClaims(user.uid, {
      role: "admin",
      superadmin: true,
    });

    console.log("  Claims set: { role: 'admin', superadmin: true }");
    console.log(`\n  Done! Login with: ${email}\n`);
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();

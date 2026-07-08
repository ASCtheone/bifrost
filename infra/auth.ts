export const auth = new aws.cognito.UserPool("BifrostAuth2", {
  name: `bifrost-${$app.stage}`,
  autoVerifiedAttributes: ["email"],
  aliasAttributes: ["email", "preferred_username"],
  usernameConfiguration: {
    caseSensitive: false,
  },
  passwordPolicy: {
    minimumLength: 12,
    requireLowercase: true,
    requireNumbers: true,
    requireSymbols: false,
    requireUppercase: true,
  },
  schemas: [
    {
      name: "email",
      attributeDataType: "String",
      required: true,
      mutable: true,
    },
  ],
});

export const adminGroup = new aws.cognito.UserGroup("BifrostAdminGroup", {
  userPoolId: auth.id,
  name: "admin",
  description: "Bifrost administrators",
});

export const superadminGroup = new aws.cognito.UserGroup("BifrostSuperadminGroup", {
  userPoolId: auth.id,
  name: "superadmin",
  description: "Bifrost super administrators",
});

export const userPoolClient = new aws.cognito.UserPoolClient(
  "BifrostAuthClient",
  {
    userPoolId: auth.id,
    name: `bifrost-app-${$app.stage}`,
    explicitAuthFlows: [
      "ALLOW_USER_PASSWORD_AUTH",
      "ALLOW_USER_SRP_AUTH",
      "ALLOW_REFRESH_TOKEN_AUTH",
    ],
    accessTokenValidity: 1,
    idTokenValidity: 1,
    refreshTokenValidity: 30,
    tokenValidityUnits: {
      accessToken: "hours",
      idToken: "hours",
      refreshToken: "days",
    },
  },
);

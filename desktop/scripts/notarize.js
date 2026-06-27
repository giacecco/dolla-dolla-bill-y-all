'use strict';

const { notarize } = require('@electron/notarize');

/**
 * Called by electron-builder after the app is signed (afterSign hook).
 * Submits the app to Apple's notarization service and waits for approval.
 */
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`\nNotarizing ${appPath}…`);

  await notarize({
    tool: 'notarytool',
    appPath,
    keychainProfile: 'ddbya-notarize',
  });

  console.log('Notarization complete.');
};

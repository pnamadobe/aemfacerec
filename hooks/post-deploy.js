const chalk = require('chalk');
const fs = require('fs');
const yaml = require('js-yaml');

module.exports = (config) => {
  try {
    const yamlFile = fs.readFileSync(`${config.root}/app.config.yaml`, 'utf8');
    const yamlData = yaml.load(yamlFile);
    const { extensions } = yamlData;

    const extension = Object.keys(extensions)[0];
    const previewData = {
      extensionPoint: extension,
      url: config.project.workspace.app_url
    };

    const base64EncodedData = Buffer.from(JSON.stringify(previewData)).toString('base64');
    console.log(
      chalk.magenta(
        chalk.bold(
          'For a developer preview of your UI extension in the AEM Assets View environment, follow the URL:'
        )
      )
    );

    const env = process.env.AIO_CLI_ENV === 'stage' ? '-stage' : '';
    console.log(
      chalk.magenta(
        chalk.bold(
          `  -> https://experience${env}.adobe.com/aem/extension-manager/preview/${base64EncodedData}`
        )
      )
    );
  } catch (error) {
    // ignore preview URL errors
  }
};

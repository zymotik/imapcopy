import Imap from 'imap';
import Commander from 'commander';
import Promise from 'bluebird';
import winston from 'winston'
import fs from 'fs';
import _ from 'lodash';
import read from 'read';
import ImapHelper from './ImapHelper';

// the gmail "all mail" box is: "[Gmail]/All Mail"


const logger = new winston.Logger({
  transports: [
    new (winston.transports.Console)({ level: 'debug' })
  ]
});

let pkg = require('../package.json');


export default class ImapCopy {
  constructor(options) {
    Commander
      .version(pkg.version)
      .option('-c, --config [configFile]', 'The path to the config file containing log in info', 'config.json')
      .option('-u, --uids [uidFile]', 'The path to store known email identifiers', 'uidsync.log')
      .option('-s, --source [mailbox]', 'The source mailbox name')
      .option('-d, --dest [mailbox]', 'The dest mailbox name')
      .option('-f, --find [mailbox]', 'Look in the specified mailbox when matching existing mail')
      .option('-n, --no-match', 'Don\'t try to match existing mail')
      .option('--since [date]', 'The first date to look for message from')
      .option('-e, --execute', 'Actually transfer the mail (instead of just pretending)')
      .option('-p, --password', 'Prompt for passwords not specified in config on the commandline')
      .parse(options);

      this.options = Commander.opts();

      if (!this.options.find) {
        this.options.find = this.options.dest;
      }

      logger.debug('Parsed command line options:');
      logger.debug(this.options);

      if (!this.options.source || !this.options.dest) {
        logger.error('must specify dest and source mailboxes');
        process.exit(1);
      }

      logger.info('loading config file "%s"', this.options.config);
      this.config = JSON.parse(fs.readFileSync(this.options.config, 'utf8'))
  }


  async run() {
    logger.info('running import');

    await this.getPassword('source');
    await this.getPassword('dest');

    let knownUids = await this.getKnownUids();

    if (knownUids) {
      logger.info('I already know %d messages', knownUids.length);
    } else {
      logger.info('First time sync');
    }

    logger.info('connecting to channel "%s"', this.config.source.host);
    let source = new ImapHelper(this.config.source);
    await source.connect();

    logger.info('connecting to channel "%s"', this.config.dest.host);
    let dest = new ImapHelper(this.config.dest);
    await dest.connect();

    await source.openBox(this.options.source);
    logger.info('%s: opened mailbox "%s"', this.config.source.host, this.options.source);

    await dest.openBox(this.options.find);
    logger.info('%s: opened mailbox "%s"', this.config.dest.host, this.options.dest);

    var uidFile = fs.createWriteStream(this.options.uids, {flags: 'a', encoding: 'utf8'});
    let sourceCriteria = ['All'];

    if (this.options.since) {
      sourceCriteria = [['SINCE', this.options.since]];
    }

    let uids = await source.search(sourceCriteria);
    logger.info('%s: found %d messages', this.config.source.host, uids.length);
    uids = _.difference(uids, knownUids);
    logger.info('%s: %d unknown messages', this.config.source.host, uids.length);

    for (let i in uids) {
      uidFile.write(uids[i] + ',');
      logger.debug('retrieving message %d of %d (%s)', i, uids.length, uids[i]);
      let message = await source.fetch(uids[i]);
      logger.verbose(message.headers.date + ' ' + message.headers.subject);

      let matches = [];

      if (this.options.match) {
        let criteria = [];
        criteria.push(['ON', message.attribs.date]);
        criteria.push(['HEADER', 'DATE', message.headers.date]);

        if (typeof message.headers.subject !== 'undefined') {
          criteria.push(['SUBJECT', message.headers.subject]);
        } else {
          criteria.push(['!HEADER', 'subject', '']);
        }

        matches = await dest.search(criteria);
        logger.debug('found %d matches on dest', matches.length);
      }

      if (!matches.length) {
        logger.verbose('saving message to dest');

        if (this.options.execute) {
          logger.debug('actually saving message to dest');

          let destUid = await dest.append(message.body, {
            mailbox: this.options.dest,
            flags: message.attribs.flags,
            date: message.attribs.date
          });

          logger.debug('saved message %s', destUid);
        }
      }
    }
  }


  async getKnownUids() {
    let readFile = Promise.promisify(fs.readFile);

    try {
      logger.info('opening uid file "%s"', this.options.uids)
      let uidlist = await readFile(this.options.uids, {encoding: 'utf8'});
      return JSON.parse('[' + uidlist.slice(0,-1) + ']');
    }
    catch (e) {
      return null;
    }
  }


  async getPassword(target) {
    return new Promise((resolve, reject) => {
      if (!this.config[target].password) {
        read({
          prompt: 'Enter password for ' + this.config[target].host + ': ',
          silent: true
        }, (err, password) => {
          if (err) {
            reject(err);
          } else {
            this.config[target].password = password;
            resolve(password);
          }
        });
      } else {
        resolve(false);
      }
    });
  }
};

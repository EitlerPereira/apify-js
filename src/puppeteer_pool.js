import _ from 'underscore';
import log from 'apify-shared/log';
import Promise from 'bluebird';
import { cryptoRandomObjectId } from 'apify-shared/utilities';
import { checkParamOrThrow } from 'apify-client/build/utils';
import { launchPuppeteer } from './puppeteer';
import { getApifyProxyUrl } from './actor';
import { isProduction } from './utils';

const DEFAULT_PUPPETEER_CONFIG = {
    dumpio: !isProduction(),
    slowMo: 0,
    args: [],
};

const PROCESS_KILL_TIMEOUT_MILLIS = 5000;

const DEFAULT_OPTIONS = {
    maxOpenPagesPerInstance: 100,
    abortInstanceAfterRequestCount: 150,

    // These can't be constants because we need it for unit tests.
    instanceKillerIntervalMillis: 60 * 1000,
    killInstanceAfterMillis: 5 * 60 * 1000,

    // TODO: use settingsRotator()
    launchPuppeteerFunction: ({ groups, puppeteerConfig, disableProxy = false }) => {
        checkParamOrThrow(groups, 'opts.groups', 'Maybe Array');
        checkParamOrThrow(puppeteerConfig, 'opts.puppeteerConfig', 'Maybe Object');
        checkParamOrThrow(disableProxy, 'opts.disableProxy', 'Maybe Boolean');

        const config = Object.assign({}, DEFAULT_PUPPETEER_CONFIG, puppeteerConfig);

        // TODO: is this needed at all? It might be confusing because the feature has the same name
        // as Chrome command line flag, so people will assume it's doing just that.
        // For simplicity I'd just remove it...
        if (config.disableWebSecurity) {
            config.ignoreHTTPSErrors = true;
            config.args.push('--disable-web-security');
        }

        // TODO: Maybe we should move this whole logic directly to Apify.launchPuppeteer().
        // E.g. if process.env.APIFY_PROXY_HOST is defined, then puppeteer should use it with "auto".
        if (!disableProxy) {
            config.proxyUrl = getApifyProxyUrl({ groups, session: cryptoRandomObjectId() });
        }

        return launchPuppeteer(config);
    },
};

/**
 * Internal representation of Puppeteer instance.
 *
 * @ignore
 */
class PuppeteerInstance {
    constructor(id, browserPromise) {
        this.id = id;
        this.activePages = 0;
        this.totalPages = 0;
        this.browserPromise = browserPromise;
        this.lastPageOpenedAt = Date.now();
        this.killed = false;
        this.childProcess = null;
    }
}

/**
 * Provides a pool of Puppeteer (Chrome browser) instances.
 * The class rotates the instances based on its configuration in order to change proxies.
 *
 * Example usage:
 *
 * ```javascript
 * const puppeteerPool = new PuppeteerPool({ groups: 'some-proxy-group' });
 *
 * const page1 = await puppeteerPool.newPage();
 * const page2 = await puppeteerPool.newPage();
 * const page3 = await puppeteerPool.newPage();
 *
 * // ... do something with pages ...
 *
 * // Close all the browsers.
 * await puppeteerPool.destroy();
 * ```
 *
 * @param {Number} [options.maxOpenPagesPerInstance=100] Maximum number of open tabs per browser. If this limit is reached then a new
 *                                                        browser will be started.
 * @param {Number} [options.abortInstanceAfterRequestCount=150] Maximum number of requests processed by a single browser.
 *                                                          After the limit is reach the browser
 *                                                              will be restarted.
 * @param {Function} [options.launchPuppeteerFunction] Overrides the default function to launch a new Puppeteer instance.
 * @param {Number} [options.instanceKillerIntervalMillis=60000] How often opened Puppeteer instances are checked wheter they can be
 *                                                              closed.
 * @param {Number} [options.killInstanceAfterMillis=300000] If Puppeteer instance reaches the `options.abortInstanceAfterRequestCount` limit then
 *                                                          it is considered retired and no more tabs will be opened. After the last tab is closed the
 *                                                          whole browser is closed too. This parameter defines a time limit for inactivity after
 *                                                          which the browser is closed even if there are pending open tabs.
 * @param {Object} [options.puppeteerConfig={ dumpio: process.env.NODE_ENV !== 'production', slowMo: 0, args: []}] Configuration of Puppeteer
 *                                                                                                                 instances.
 * @param {Boolean} [options.disableProxy=false] Disables proxying through Apify proxy.
 * @param {Array} [options.groups] Apify proxy groups to be used. See `Apify.getApifyProxyUrl()` for more details.
 */
export default class PuppeteerPool {
    constructor(opts = {}) {
        checkParamOrThrow(opts, 'opts', 'Object');

        const {
            maxOpenPagesPerInstance,
            abortInstanceAfterRequestCount,
            launchPuppeteerFunction,
            instanceKillerIntervalMillis,
            killInstanceAfterMillis,
        } = _.defaults(opts, DEFAULT_OPTIONS);

        checkParamOrThrow(maxOpenPagesPerInstance, 'opts.maxOpenPagesPerInstance', 'Number');
        checkParamOrThrow(abortInstanceAfterRequestCount, 'opts.abortInstanceAfterRequestCount', 'Number');
        checkParamOrThrow(launchPuppeteerFunction, 'opts.launchPuppeteerFunction', 'Function');
        checkParamOrThrow(instanceKillerIntervalMillis, 'opts.instanceKillerIntervalMillis', 'Number');
        checkParamOrThrow(killInstanceAfterMillis, 'opts.killInstanceAfterMillis', 'Number');

        // Config.
        this.maxOpenPagesPerInstance = maxOpenPagesPerInstance;
        this.abortInstanceAfterRequestCount = abortInstanceAfterRequestCount;
        this.killInstanceAfterMillis = killInstanceAfterMillis;
        this.launchPuppeteerFunction = () => launchPuppeteerFunction(opts);

        // State.
        this.browserCounter = 0;
        this.activeInstances = {};
        this.retiredInstances = {};
        this.instanceKillerInterval = setInterval(() => this._killRetiredInstances(), instanceKillerIntervalMillis);
    }

    /**
     * Launches new browser instance.
     *
     * @ignore
     */
    _launchInstance() {
        const id = this.browserCounter++;
        const browserPromise = this.launchPuppeteerFunction();
        const instance = new PuppeteerInstance(id, browserPromise);

        instance
            .browserPromise
            .then((browser) => {
                browser.on('disconnected', () => {
                    // If instance.killed === true then we killed the instance so don't log it.
                    if (!instance.killed) log.error('PuppeteerPool: Puppeteer sent "disconnect" event. Crashed???', { id });
                    this._retireInstance(instance);
                });
                // This one is done manually in Puppeteerpool.newPage() to happen immediately.
                // browser.on('targetcreated', () => instance.activePages++);
                browser.on('targetdestroyed', () => {
                    instance.activePages--;

                    if (instance.activePages === 0 && this.retiredInstances[id]) this._killInstance(instance);
                });

                instance.childProcess = browser.process();
            })
            .catch((err) => {
                log.exception(err, 'PuppeteerPool: Browser start failed', { id });

                return this._retireInstance(instance);
            });

        this.activeInstances[id] = instance;

        return instance;
    }

    /**
     * Retires some of the instances for example due to to many uses.
     *
     * @ignore
     */
    _retireInstance(instance) {
        const { id } = instance;

        if (!this.activeInstances[id]) return log.warning('PuppeteerPool: browser is retired already', { id });

        log.info('PuppeteerPool: retiring browser', { id });

        this.retiredInstances[id] = instance;
        delete this.activeInstances[id];
    }

    /**
     * Kills all the retired instances that:
     * - have all tabs closed
     * - or are inactive for more then killInstanceAfterMillis.
     *
     * @ignore
     */
    _killRetiredInstances() {
        log.info('PuppeteerPool: retired browsers count', { count: _.values(this.retiredInstances).length });

        _.mapObject(this.retiredInstances, (instance) => {
            // Kill instances that are more than this.killInstanceAfterMillis from last opened page
            if (Date.now() - instance.lastPageOpenedAt > this.killInstanceAfterMillis) this._killInstance(instance);

            instance
                .browserPromise
                .then(browser => browser.pages())
                .then((pages) => {
                    if (pages.length === 0) this._killInstance(instance);
                }, (err) => {
                    log.exception(err, 'PuppeteerPool: browser.pages() failed', { id: instance.id });
                    this._killInstance(instance);
                });
        });
    }

    /**
     * Kills given browser instance.
     *
     * @ignore
     */
    _killInstance(instance) {
        const { id, childProcess } = instance;

        log.info('PuppeteerPool: killing browser', { id });

        delete this.retiredInstances[id];

        // Ensure that Chrome process will be really killed.
        setTimeout(() => {
            // This if is here because users reported that it happened
            // that error `TypeError: Cannot read property 'kill' of null` was thrown.
            // Likely Chrome process wasn't started for some error ...
            if (childProcess) childProcess.kill('SIGKILL');
        }, PROCESS_KILL_TIMEOUT_MILLIS);

        instance
            .browserPromise
            .then((browser) => {
                if (instance.killed) return;

                instance.killed = true;

                return browser.close();
            })
            .catch(err => log.exception(err, 'PuppeteerPool: cannot close the browser instance', { id }));
    }

    /**
     * Opens new tab in one of the browsers and returns promise that resolves to it's Puppeteer.Page.
     *
     * @return {Promise<Puppeteer.Page>}
     */
    newPage() {
        let instance;

        _.mapObject(this.activeInstances, (inst) => {
            if (inst.activePages >= this.maxOpenPagesPerInstance) return;

            instance = inst;
        });

        if (!instance) instance = this._launchInstance();

        instance.lastPageOpenedAt = Date.now();
        instance.totalPages++;
        instance.activePages++;

        if (instance.totalPages >= this.abortInstanceAfterRequestCount) this._retireInstance(instance);

        return instance.browserPromise
            .then(browser => browser.newPage())
            .then((page) => {
                page.on('error', (error) => {
                    log.exception(error, 'PuppeteerPool: page crashed');
                    page.close();
                });

                // TODO: log console messages page.on('console', message => log.debug(`Chrome console: ${message.text}`));

                return page;
            })
            .catch((err) => {
                log.exception(err, 'PuppeteerPool: browser.newPage() failed', { id: instance.id });
                this._retireInstance(instance);

                // !TODO: don't throw an error but repeat newPage with some delay
                throw err;
            });
    }

    /**
     * Closes all the browsers.
     */
    destroy() {
        clearInterval(this.instanceKillerInterval);

        const browserPromises = _
            .values(this.activeInstances)
            .concat(_.values(this.retiredInstances))
            .map((instance) => {
                // This is needed so that "Puppeteer disconnected" errors are not printed.
                instance.killed = true;

                return instance.browserPromise;
            });

        const closePromises = browserPromises.map((browserPromise) => {
            return browserPromise.then(browser => browser.close());
        });

        return Promise
            .all(closePromises)
            .catch(err => log.exception(err, 'PuppeteerPool: cannot close the browsers'));
    }
}

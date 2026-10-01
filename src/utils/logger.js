const PREFIX = '[grass-test]';

export const logger = {
  info(message, context) {
    if (context === undefined) console.info(PREFIX, message);
    else console.info(PREFIX, message, context);
  },
  warn(message, context) {
    if (context === undefined) console.warn(PREFIX, message);
    else console.warn(PREFIX, message, context);
  },
  error(message, context) {
    if (context === undefined) console.error(PREFIX, message);
    else console.error(PREFIX, message, context);
  },
};

import * as vscode from "vscode";
import * as semver from "semver";
import {
  Channel,
  CurrentUser,
  ChannelMessages,
  Messages,
  Users,
  IStore,
  User,
  Team,
  ChannelType,
  ChannelLabel,
  UserPreferences,
  IChatProvider,
  MessageReply,
  MessageReplies
} from "./interfaces";
import StatusItem from "./status";
import Logger from "./logger";
import { getExtensionVersion, uuidv4, isSuperset, difference } from "./utils";
import { DiscordChatProvider } from "./discord";
import { SlackChatProvider } from "./slack";
import {
  UnreadsTreeProvider,
  ChannelTreeProvider,
  GroupTreeProvider,
  IMsTreeProvider,
  OnlineUsersTreeProvider
} from "./tree";
import { OnboardingTreeProvider } from "./onboarding";
import { SelfCommands } from "./constants";

const stateKeys = {
  EXTENSION_VERSION: "extensionVersion",
  INSTALLATION_ID: "installationId",
  LAST_CHANNEL_ID: "lastChannelId",
  CHANNELS: "channels",
  USER_INFO: "userInfo",
  USERS: "users"
};

// Large discord communities like Reactiflux are not getting saved
// due to quota limits of context.globalState
const STORAGE_SIZE_LIMIT = 100;

export default class Store implements IStore, vscode.Disposable {
  token: string;
  installationId: string;
  lastChannelId: string;
  channels: Channel[] = [];
  channelsFetchedAt: Date;
  currentUserInfo: CurrentUser;
  currentUserPrefs: UserPreferences = {};
  users: Users = {};
  usersFetchedAt: Date;
  messages: Messages = {};
  statusItem: StatusItem;

  unreadsTreeProvider: UnreadsTreeProvider;
  channelsTreeProvider: ChannelTreeProvider;
  imsTreeProvider: IMsTreeProvider;
  groupsTreeProvider: GroupTreeProvider;
  usersTreeProvider: OnlineUsersTreeProvider;
  onboardingTreeProvider: OnboardingTreeProvider;

  chatProvider: IChatProvider;

  constructor(private context: vscode.ExtensionContext) {
    const { globalState } = context;
    this.channels = globalState.get(stateKeys.CHANNELS);
    this.currentUserInfo = globalState.get(stateKeys.USER_INFO);
    this.users = globalState.get(stateKeys.USERS);
    this.lastChannelId = globalState.get(stateKeys.LAST_CHANNEL_ID);
    this.installationId = globalState.get(stateKeys.INSTALLATION_ID);

    this.statusItem = new StatusItem();

    const existingVersion: string = globalState.get(
      stateKeys.EXTENSION_VERSION
    );
    const currentVersion = getExtensionVersion();

    if (existingVersion !== currentVersion) {
      // There has been an upgrade. Apply data migrations if required.
      Logger.log(`Extension updated to ${currentVersion}`);

      if (!!existingVersion) {
        if (semver.lt(existingVersion, "0.6.0")) {
          Logger.log("Migration for 0.6.0: add slack as default provider");

          if (!!this.currentUserInfo) {
            this.currentUserInfo.provider = "slack";
          }
        }
      }

      globalState.update(stateKeys.EXTENSION_VERSION, currentVersion);
      const newstate = globalState.get(stateKeys.EXTENSION_VERSION);
      Logger.log(`Updated state to new version: ${newstate}`);
    }
  }

  getSelectedProvider() {
    return !!this.currentUserInfo ? this.currentUserInfo.provider : undefined;
  }

  initializeToken = async (selectedProvider?: string) => {
    if (!selectedProvider) {
      selectedProvider = this.getSelectedProvider();
    }

    const ALL_PROVIDERS = ["slack", "discord"];

    switch (selectedProvider) {
      case "discord":
        this.chatProvider = new DiscordChatProvider(this);
        break;
      case "slack":
        this.chatProvider = new SlackChatProvider();
        break;
    }

    if (!!selectedProvider) {
      this.usersTreeProvider = new OnlineUsersTreeProvider(selectedProvider);
      this.unreadsTreeProvider = new UnreadsTreeProvider(selectedProvider);
      this.channelsTreeProvider = new ChannelTreeProvider(selectedProvider);
      this.groupsTreeProvider = new GroupTreeProvider(selectedProvider);
      this.imsTreeProvider = new IMsTreeProvider(selectedProvider);

      if (!!this.onboardingTreeProvider) {
        this.onboardingTreeProvider.dispose();
      }

      const token = await this.chatProvider.getToken();
      this.token = token;
    } else {
      this.onboardingTreeProvider = new OnboardingTreeProvider();
    }

    ALL_PROVIDERS.forEach(provider => {
      vscode.commands.executeCommand(
        "setContext",
        `chat:${provider}`,
        provider === selectedProvider
      );
    });
  };

  initializeProvider = async (): Promise<any> => {
    const isConnected = this.chatProvider.isConnected();
    const isAuthenticated = this.isAuthenticated();
    let currentUser = this.currentUserInfo;

    if (!(isConnected && isAuthenticated)) {
      currentUser = await this.chatProvider.connect();
      this.updateCurrentUser(currentUser);
    }

    return currentUser;
  };

  generateInstallationId() {
    const uuidStr = uuidv4();
    const { globalState } = this.context;
    globalState.update(stateKeys.INSTALLATION_ID, uuidStr);
    this.installationId = uuidStr;
  }

  clearAll() {
    this.updateCurrentUser(undefined);
    this.clearOldWorkspace();
  }

  clearOldWorkspace() {
    // This clears workspace info, does not clear current user
    this.updateLastChannelId(undefined);
    this.updateChannels([]);
    this.updateUsers({});
    this.usersFetchedAt = undefined;
    this.channelsFetchedAt = undefined;
    this.messages = {};
    this.token = undefined;

    if (!!this.chatProvider) {
      this.chatProvider.destroy();
    }
  }

  updateAllUI() {
    this.updateUnreadCount();
    this.updateTreeViews();
    this.updateWebviewUI();
  }

  dispose() {
    this.statusItem.dispose();
    this.unreadsTreeProvider.dispose();
    this.channelsTreeProvider.dispose();
    this.groupsTreeProvider.dispose();
    this.imsTreeProvider.dispose();
    this.usersTreeProvider.dispose();
  }

  isAuthenticated() {
    return !!this.currentUserInfo && !!this.currentUserInfo.id;
  }

  getChannel(channelId: string): Channel {
    return this.channels.find(channel => channel.id === channelId);
  }

  isChannelMuted(channelId: string): boolean {
    const { mutedChannels } = this.currentUserPrefs;
    return !!mutedChannels && mutedChannels.indexOf(channelId) >= 0;
  }

  getChannelLabels(): ChannelLabel[] {
    return this.channels.map(channel => {
      const unread = this.getUnreadCount(channel);
      const { name, type, id } = channel;
      const isMuted = this.isChannelMuted(id);
      let isOnline = false;

      if (type === ChannelType.im) {
        const relatedUserId = Object.keys(this.users).find(value => {
          const user = this.users[value];
          const { name: username } = user;
          // Same issue as getIMChannel(), so we handle both
          return `@${username}` === name || username === name;
        });

        if (!!relatedUserId) {
          const relatedUser = this.users[relatedUserId];
          isOnline = relatedUser.isOnline;
        }
      }

      let label;

      if (unread > 0) {
        label = `${name} ${unread > 0 ? `(${unread} new)` : ""}`;
      } else if (isMuted) {
        label = `${name} (muted)`;
      } else {
        label = `${name}`;
      }

      return {
        channel,
        unread,
        label,
        isOnline
      };
    });
  }

  getIMChannel(user: User): Channel | undefined {
    // Hacky implementation to tackle chat provider differences
    // Slack: DM channels look like `@name`
    // Discord: DM channels look like `name`
    const { name } = user;
    return this.channels.find(
      channel => channel.name === `@${name}` || channel.name === name
    );
  }

  createIMChannel(user: User): Promise<Channel> {
    return this.chatProvider.createIMChannel(user).then(channel => {
      this.updateChannel(channel);
      return channel;
    });
  }

  updateWebviewUI() {
    const channel = this.getChannel(this.lastChannelId);
    const messages =
      this.lastChannelId in this.messages
        ? this.messages[this.lastChannelId]
        : {};

    vscode.commands.executeCommand(SelfCommands.SEND_TO_WEBVIEW, {
      uiMessage: {
        messages,
        users: this.users,
        currentUser: this.currentUserInfo,
        channel,
        statusText: ""
      }
    });
  }

  getUnreadCount(channel: Channel): number {
    const { id, readTimestamp, unreadCount } = channel;

    if (this.isChannelMuted(id)) {
      // This channel is muted, so return 0
      return 0;
    }

    const messages = id in this.messages ? this.messages[id] : {};
    const unreadMessages = Object.keys(messages).filter(ts => {
      const isDifferentUser = messages[ts].userId !== this.currentUserInfo.id;
      const isNewTimestamp = !!readTimestamp ? +ts > +readTimestamp : false;
      return isDifferentUser && isNewTimestamp;
    });
    return unreadCount ? unreadCount : unreadMessages.length;
  }

  updateTreeViews() {
    if (this.isAuthenticated()) {
      const channelLabels = this.getChannelLabels();
      this.unreadsTreeProvider.update(channelLabels);
      this.channelsTreeProvider.update(channelLabels);
      this.groupsTreeProvider.update(channelLabels);
      this.imsTreeProvider.update(channelLabels);

      // We could possibly split this function for channel-updates and user-updates
      // to avoid extra UI refresh calls.
      const imChannels = {};
      Object.keys(this.users).forEach(userId => {
        const im = this.getIMChannel(this.users[userId]);

        if (!!im) {
          imChannels[userId] = im;
        }
      });

      this.usersTreeProvider.updateData(
        this.currentUserInfo,
        this.users,
        imChannels
      );
    }
  }

  updateUnreadCount() {
    const unreads = this.channels.map(channel => this.getUnreadCount(channel));
    const totalUnreads = unreads.reduce((a, b) => a + b, 0);
    this.statusItem.updateCount(totalUnreads);
  }

  updateUserPresence = (userId: string, isOnline: boolean) => {
    if (userId in this.users) {
      this.users[userId] = {
        ...this.users[userId],
        isOnline
      };

      this.updateTreeViews();
    }
  };

  updateUsers = (users): Thenable<void> => {
    this.users = users;

    if (Object.keys(this.users).length <= STORAGE_SIZE_LIMIT) {
      return this.context.globalState.update(stateKeys.USERS, this.users);
    }
  };

  updateUsersFetchedAt = () => {
    this.usersFetchedAt = new Date();
  };

  updateChannelsFetchedAt = () => {
    this.channelsFetchedAt = new Date();
  };

  updateChannels = channels => {
    this.channels = channels;

    if (this.channels.length <= STORAGE_SIZE_LIMIT) {
      this.context.globalState.update(stateKeys.CHANNELS, this.channels);
    }
  };

  updateChannel = (newChannel: Channel) => {
    // Adds/updates channel in this.channels
    let found = false;
    let updatedChannels = this.channels.map(channel => {
      const { id } = channel;

      if (id === newChannel.id) {
        found = true;
        return {
          ...channel,
          ...newChannel
        };
      } else {
        return channel;
      }
    });

    if (!found) {
      updatedChannels = [...updatedChannels, newChannel];
    }

    this.updateChannels(updatedChannels);
    this.updateTreeViews();
  };

  fetchUsers = (): Promise<Users> => {
    return this.chatProvider.fetchUsers().then((users: Users) => {
      let usersWithPresence: Users = {};

      Object.keys(users).forEach(userId => {
        // This handles two different chat providers:
        // In slack, we will get isOnline as undefined, because this API
        //    does not know about user presence
        // In discord, we will get true/false
        const existingUser = userId in this.users ? this.users[userId] : null;
        const newUser = users[userId];
        let calculatedIsOnline: boolean;

        if (newUser.isOnline !== undefined) {
          calculatedIsOnline = newUser.isOnline;
        } else {
          calculatedIsOnline = !!existingUser ? existingUser.isOnline : false;
        }

        usersWithPresence[userId] = {
          ...users[userId],
          isOnline: calculatedIsOnline
        };
      });

      this.updateUsers(usersWithPresence);
      this.updateUsersFetchedAt();
      return users;
    });
  };

  fetchChannels = (): Promise<Channel[]> => {
    return this.chatProvider.fetchChannels(this.users).then(channels => {
      this.updateChannels(channels);
      this.updateChannelsFetchedAt();
      this.updateTreeViews();

      // We have to fetch twice here because Slack does not return the
      // historical unread counts for channels in the list API.
      const promises = channels.map(channel =>
        this.chatProvider
          .fetchChannelInfo(channel)
          .then((newChannel: Channel) => {
            return this.updateChannel(newChannel);
          })
      );

      Promise.all(promises).then(() => this.updateUnreadCount());
      return channels;
    });
  };

  shouldFetchNew = (lastFetchedAt: Date): boolean => {
    if (!lastFetchedAt) {
      return true;
    }

    const now = new Date();
    const difference = now.valueOf() - lastFetchedAt.valueOf();
    const FETCH_THRESHOLD = 15 * 60 * 1000; // 15-mins
    return difference > FETCH_THRESHOLD;
  };

  getUsersPromise(): Promise<Users> {
    function isNotEmpty(obj) {
      return Object.keys(obj).length !== 0;
    }

    return isNotEmpty(this.users)
      ? new Promise(resolve => {
          if (this.shouldFetchNew(this.usersFetchedAt)) {
            this.fetchUsers(); // async update
          }
          resolve(this.users);
        })
      : this.fetchUsers();
  }

  getChannelsPromise(): Promise<Channel[]> {
    // This assumes that users are available
    return !!this.channels
      ? new Promise(resolve => {
          if (this.shouldFetchNew(this.channelsFetchedAt)) {
            this.fetchChannels(); // async update
          }
          resolve(this.channels);
        })
      : this.fetchChannels();
  }

  updateLastChannelId = (channelId: string): Thenable<void> => {
    this.lastChannelId = channelId;
    return this.context.globalState.update(
      stateKeys.LAST_CHANNEL_ID,
      this.lastChannelId
    );
  };

  updateCurrentUser = (userInfo: CurrentUser): Thenable<void> => {
    // In the case of discord, we need to know the current team (guild)
    // If that is available in the store, we should use that
    if (!userInfo) {
      // Resetting userInfo
      this.currentUserInfo = userInfo;
    } else {
      let currentTeamId: string = !!this.currentUserInfo
        ? this.currentUserInfo.currentTeamId
        : undefined;

      if (!!userInfo.currentTeamId) {
        currentTeamId = userInfo.currentTeamId;
      }

      this.currentUserInfo = { ...userInfo, currentTeamId };
    }

    return this.context.globalState.update(
      stateKeys.USER_INFO,
      this.currentUserInfo
    );
  };

  updateCurrentWorkspace = (team: Team): Thenable<void> => {
    const newCurrentUser: CurrentUser = {
      ...this.currentUserInfo,
      currentTeamId: team.id
    };
    return this.updateCurrentUser(newCurrentUser);
  };

  updateMessages = (channelId: string, newMessages: ChannelMessages) => {
    const channelMessages = { ...this.messages[channelId], ...newMessages };
    this.messages[channelId] = channelMessages;

    // Remove undefined, after message deleted
    Object.keys(this.messages[channelId]).forEach(key => {
      if (typeof this.messages[channelId][key] === "undefined") {
        delete this.messages[channelId][key];
      }
    });

    // Check if we have all users. Since there is not bots.list API
    // method, it is possible that a bot user is not in our store
    const userIds = new Set(
      (<any>Object)
        .values(this.messages[channelId])
        .map(message => message.userId)
    );
    const allIds = new Set(Object.keys(this.users));
    if (!isSuperset(allIds, userIds)) {
      this.fillUpUsers(difference(userIds, allIds));
    }

    this.updateAllUI();
  };

  fillUpUsers(missingIds: Set<any>): Promise<void> {
    // missingIds are user/bot ids that we don't have in the store. We will
    // fetch their details, and then update the UI.
    const usersCopy = { ...this.users };
    let ids = Array.from(missingIds);

    return Promise.all(
      ids.map(userId => {
        return this.chatProvider.fetchUserInfo(userId).then((user: User) => {
          const { id } = user;
          usersCopy[id] = user;
        });
      })
    ).then(() => {
      this.users = usersCopy;
      return this.updateWebviewUI();
    });
  }

  loadChannelHistory(channelId: string): Promise<void> {
    return this.chatProvider
      .loadChannelHistory(channelId)
      .then(messages => this.updateMessages(channelId, messages))
      .catch(error => console.error(error));
  }

  updateUserPrefs() {
    return this.chatProvider.getUserPrefs().then(response => {
      // We could also save the muted channels to local storage
      this.currentUserPrefs = response;
      this.updateUnreadCount();
    });
  }

  getLastTimestamp(): string {
    const id = this.lastChannelId;
    const channelMessages = id in this.messages ? this.messages[id] : {};
    const timestamps = Object.keys(channelMessages).map(tsString => +tsString);

    if (timestamps.length > 0) {
      return Math.max(...timestamps).toString();
    }
  }

  updateReadMarker(): void {
    const channelId = this.lastChannelId;
    const channel = this.getChannel(channelId);
    const lastTs = this.getLastTimestamp();

    if (channel && lastTs) {
      const { readTimestamp } = channel;
      const hasNewerMsgs = +readTimestamp < +lastTs;

      if (!readTimestamp || hasNewerMsgs) {
        const channel = this.getChannel(channelId);
        const incremented = (+lastTs + 1).toString(); // Slack API workaround
        this.chatProvider.markChannel(channel, incremented).then(channel => {
          this.updateChannel(channel);
          this.updateAllUI();
        });
      }
    }
  }

  addReaction(
    channelId: string,
    msgTimestamp: string,
    userId: string,
    reactionName: string
  ) {
    if (channelId in this.messages) {
      const channelMessages = this.messages[channelId];

      if (msgTimestamp in channelMessages) {
        const message = channelMessages[msgTimestamp];
        let { reactions } = message;
        const existing = reactions.find(r => r.name === reactionName);

        if (existing) {
          reactions = reactions.map(r => {
            if (r.name === reactionName) {
              return {
                ...existing,
                count: existing.count + 1,
                userIds: [...existing.userIds, userId]
              };
            } else {
              return { ...r };
            }
          });
        } else {
          reactions = [
            ...reactions,
            { name: reactionName, userIds: [userId], count: 1 }
          ];
        }

        const newMessage = {
          ...message,
          reactions
        };
        const newMessages = {};
        newMessages[msgTimestamp] = newMessage;
        this.updateMessages(channelId, newMessages);
      }
    }
  }

  removeReaction(
    channelId: string,
    msgTimestamp: string,
    userId: string,
    reactionName: string
  ) {
    if (channelId in this.messages) {
      const channelMessages = this.messages[channelId];

      if (msgTimestamp in channelMessages) {
        const message = channelMessages[msgTimestamp];
        let { reactions } = message;
        reactions = reactions
          .map(r => {
            if (r.name === reactionName) {
              return {
                ...r,
                count: r.count - 1,
                userIds: r.userIds.filter(u => u !== userId)
              };
            } else {
              return { ...r };
            }
          })
          .filter(r => r.count > 0);

        const newMessage = {
          ...message,
          reactions
        };
        const newMessages = {};
        newMessages[msgTimestamp] = newMessage;
        this.updateMessages(channelId, newMessages);
      }
    }
  }

  fetchThreadReplies(parentTimestamp: string) {
    // Assume this is the current channel
    const currentChannelId = this.lastChannelId;
    return this.chatProvider
      .fetchThreadReplies(currentChannelId, parentTimestamp)
      .then(message => {
        let messages = {};
        messages[parentTimestamp] = message;
        this.updateMessages(currentChannelId, messages);
      });
  }

  updateMessageReply(
    parentTimestamp: string,
    channelId: string,
    reply: MessageReply
  ) {
    // We need to have the message in our store, else we
    // ignore this reply
    const messages = channelId in this.messages ? this.messages[channelId] : {};
    const message =
      parentTimestamp in messages ? messages[parentTimestamp] : undefined;

    if (!!message) {
      let newMessages = {};
      const replyTs = reply.timestamp;
      let replies: MessageReplies = { ...message.replies };
      replies[replyTs] = { ...reply };
      newMessages[parentTimestamp] = {
        ...message,
        replies
      };
      this.updateMessages(channelId, newMessages);
    }
  }

  runAuthTest(): Promise<string> {
    return this.chatProvider.getAuthTest();
  }
}

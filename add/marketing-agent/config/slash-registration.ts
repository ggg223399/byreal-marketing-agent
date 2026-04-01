import { SlashCommandBuilder } from 'discord.js';

function addConfigFileChoices(option: any) {
  return option.addChoices(
    { name: 'accounts.yaml', value: 'accounts' },
    { name: 'sources.yaml', value: 'sources' },
    { name: 'judge.yaml', value: 'judge' },
    { name: 'reactor.yaml', value: 'reactor' },
    { name: 'routing.yaml', value: 'routing' },
    { name: 'brand_context.md', value: 'brand-context' },
  );
}

export function buildConfigCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName('config')
    .setDescription('Manage Marketing Agent configuration');

  // /config view
  cmd.addSubcommand((sub) =>
    sub.setName('view').setDescription('View config overview'),
  );

  // /config accounts-list [group]
  cmd.addSubcommand((sub) =>
    sub
      .setName('accounts-list')
      .setDescription('List monitored accounts')
      .addStringOption((opt) =>
        opt.setName('group').setDescription('Account group').setAutocomplete(true),
      ),
  );

  // /config accounts-add <group> <handle>
  cmd.addSubcommand((sub) =>
    sub
      .setName('accounts-add')
      .setDescription('Add a Twitter account to monitor')
      .addStringOption((opt) =>
        opt.setName('group').setDescription('Which group').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt.setName('handle').setDescription('Twitter handle (e.g. solana)').setRequired(true),
      ),
  );

  // /config accounts-remove <group> <handle>
  cmd.addSubcommand((sub) =>
    sub
      .setName('accounts-remove')
      .setDescription('Remove a Twitter account')
      .addStringOption((opt) =>
        opt.setName('group').setDescription('Which group').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt.setName('handle').setDescription('Twitter handle to remove').setRequired(true).setAutocomplete(true),
      ),
  );

  // /config keywords-list
  cmd.addSubcommand((sub) =>
    sub.setName('keywords-list').setDescription('List trend monitoring keywords'),
  );

  // /config keywords-add <keyword>
  cmd.addSubcommand((sub) =>
    sub
      .setName('keywords-add')
      .setDescription('Add a trend keyword')
      .addStringOption((opt) =>
        opt.setName('keyword').setDescription('Keyword to add').setRequired(true),
      ),
  );

  // /config keywords-remove <keyword>
  cmd.addSubcommand((sub) =>
    sub
      .setName('keywords-remove')
      .setDescription('Remove a trend keyword')
      .addStringOption((opt) =>
        opt.setName('keyword').setDescription('Keyword to remove').setRequired(true).setAutocomplete(true),
      ),
  );

  // /config sources-list
  cmd.addSubcommand((sub) =>
    sub.setName('sources-list').setDescription('List all signal sources with schedules'),
  );

  // /config source-set-max <source> <value>
  cmd.addSubcommand((sub) =>
    sub
      .setName('source-set-max')
      .setDescription('Set max_tweets for a source')
      .addStringOption((opt) =>
        opt.setName('source').setDescription('Source name').setRequired(true).setAutocomplete(true),
      )
      .addIntegerOption((opt) =>
        opt.setName('value').setDescription('Max tweets per run (1-20)').setRequired(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('prompt-view')
      .setDescription('View a source/judge/reactor/brand prompt')
      .addStringOption((opt) =>
        opt
          .setName('target')
          .setDescription('Which prompt to view')
          .setRequired(true)
          .addChoices(
            { name: 'source', value: 'source' },
            { name: 'judge', value: 'judge' },
            { name: 'reactor', value: 'reactor' },
            { name: 'brand-context', value: 'brand-context' },
          ),
      )
      .addStringOption((opt) =>
        opt.setName('source').setDescription('Source name when target=source').setAutocomplete(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('prompt-set')
      .setDescription('Update a source/judge/reactor/brand prompt')
      .addStringOption((opt) =>
        opt
          .setName('target')
          .setDescription('Which prompt to update')
          .setRequired(true)
          .addChoices(
            { name: 'source', value: 'source' },
            { name: 'judge', value: 'judge' },
            { name: 'reactor', value: 'reactor' },
            { name: 'brand-context', value: 'brand-context' },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName('content')
          .setDescription('New prompt content')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('source').setDescription('Source name when target=source').setAutocomplete(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('prompt-edit')
      .setDescription('Open a picker to edit prompts'),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('yaml-view')
      .setDescription('View a full YAML config file')
      .addStringOption((opt) =>
        addConfigFileChoices(opt
          .setName('file')
          .setDescription('Which config file to view')
          .setRequired(true)),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('yaml-edit')
      .setDescription('Download a YAML config file for editing')
      .addStringOption((opt) =>
        addConfigFileChoices(opt
          .setName('file')
          .setDescription('Which config file to edit')
          .setRequired(true)),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('yaml-apply')
      .setDescription('Upload a revised YAML config file')
      .addStringOption((opt) =>
        addConfigFileChoices(opt
          .setName('file')
          .setDescription('Which config file you are replacing')
          .setRequired(true)),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName('upload')
          .setDescription('The revised YAML file to apply')
          .setRequired(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('yaml-rollback')
      .setDescription('Restore the latest YAML backup for a config file')
      .addStringOption((opt) =>
        addConfigFileChoices(opt
          .setName('file')
          .setDescription('Which config file to roll back')
          .setRequired(true)),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('file-view')
      .setDescription('View a full config file')
      .addStringOption((opt) =>
        addConfigFileChoices(opt
          .setName('file')
          .setDescription('Which config file to view')
          .setRequired(true)),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('file-edit')
      .setDescription('Download a config file for editing')
      .addStringOption((opt) =>
        addConfigFileChoices(opt
          .setName('file')
          .setDescription('Which config file to edit')
          .setRequired(true)),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('file-apply')
      .setDescription('Upload a revised config file')
      .addStringOption((opt) =>
        addConfigFileChoices(opt
          .setName('file')
          .setDescription('Which config file you are replacing')
          .setRequired(true)),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName('upload')
          .setDescription('The revised config file to apply')
          .setRequired(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('file-rollback')
      .setDescription('Restore the latest backup for a config file')
      .addStringOption((opt) =>
        addConfigFileChoices(opt
          .setName('file')
          .setDescription('Which config file to roll back')
          .setRequired(true)),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub.setName('access-list').setDescription('List config governance settings'),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('access-add-user')
      .setDescription('Allow a Discord user to use /config')
      .addStringOption((opt) =>
        opt
          .setName('user_id')
          .setDescription('Discord user ID')
          .setRequired(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('access-remove-user')
      .setDescription('Remove a Discord user from /config allowlist')
      .addStringOption((opt) =>
        opt
          .setName('user_id')
          .setDescription('Discord user ID')
          .setRequired(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('access-add-role')
      .setDescription('Allow a Discord role to use /config')
      .addStringOption((opt) =>
        opt
          .setName('role_id')
          .setDescription('Discord role ID')
          .setRequired(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('access-remove-role')
      .setDescription('Remove a Discord role from /config allowlist')
      .addStringOption((opt) =>
        opt
          .setName('role_id')
          .setDescription('Discord role ID')
          .setRequired(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('access-set-channel')
      .setDescription('Restrict /config usage to one Discord channel')
      .addStringOption((opt) =>
        opt
          .setName('channel_id')
          .setDescription('Discord channel ID')
          .setRequired(true),
      ),
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName('access-clear-channel')
      .setDescription('Remove the /config channel restriction'),
  );

  return cmd as SlashCommandBuilder;
}

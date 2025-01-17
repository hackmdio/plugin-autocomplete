import * as child_process from 'child_process'
import * as path from 'path'

import * as fs from 'fs-extra'

import bashAutocomplete from '../../autocomplete/bash'
import ZshCompWithSpaces from '../../autocomplete/zsh'
import bashAutocompleteWithSpaces from '../../autocomplete/bash-spaces'
import {AutocompleteBase} from '../../base'

const debug = require('debug')('autocomplete:create')

type CommandCompletion = {
  id: string;
  description: string;
  flags?: any;
}

function sanitizeDescription(description?: string): string {
  if (description === undefined) {
    return ''
  }
  return description
  .replace(/([`"])/g, '\\\\\\$1') // backticks and double-quotes require triple-backslashes
  // eslint-disable-next-line no-useless-escape
  .replace(/([\[\]])/g, '\\\\$1') // square brackets require double-backslashes
  .split('\n')[0] // only use the first line
}

export default class Create extends AutocompleteBase {
  static hidden = true

  static description = 'create autocomplete setup scripts and completion functions'

  private _commands?: CommandCompletion[]

  async run() {
    this.errorIfWindows()
    // 1. ensure needed dirs
    await this.ensureDirs()
    // 2. save (generated) autocomplete files
    await this.createFiles()
  }

  private async ensureDirs() {
    // ensure autocomplete cache dir
    await fs.ensureDir(this.autocompleteCacheDir)
    // ensure autocomplete bash function dir
    await fs.ensureDir(this.bashFunctionsDir)
    // ensure autocomplete zsh function dir
    await fs.ensureDir(this.zshFunctionsDir)
  }

  private async createFiles() {
    await fs.writeFile(this.bashSetupScriptPath, this.bashSetupScript)
    await fs.writeFile(this.bashCompletionFunctionPath, this.bashCompletionFunction)
    await fs.writeFile(this.zshSetupScriptPath, this.zshSetupScript)
    // zsh
    const supportSpaces = this.config.topicSeparator === ' '

    if (process.env.OCLIF_AUTOCOMPLETE_TOPIC_SEPARATOR === 'colon' || !supportSpaces) {
      await fs.writeFile(this.zshCompletionFunctionPath, this.zshCompletionFunction)
    } else {
      const zshCompWithSpaces = new ZshCompWithSpaces(this.config)
      await fs.writeFile(this.zshCompletionFunctionPath, zshCompWithSpaces.generate())
    }
    await fs.writeFile(this.fishCompletionFunctionPath, this.fishCompletionFunction)
  }

  private get bashSetupScriptPath(): string {
    // <cachedir>/autocomplete/bash_setup
    return path.join(this.autocompleteCacheDir, 'bash_setup')
  }

  private get zshSetupScriptPath(): string {
    // <cachedir>/autocomplete/zsh_setup
    return path.join(this.autocompleteCacheDir, 'zsh_setup')
  }

  private get bashFunctionsDir(): string {
    // <cachedir>/autocomplete/functions/bash
    return path.join(this.autocompleteCacheDir, 'functions', 'bash')
  }

  private get zshFunctionsDir(): string {
    // <cachedir>/autocomplete/functions/zsh
    return path.join(this.autocompleteCacheDir, 'functions', 'zsh')
  }

  private get bashCompletionFunctionPath(): string {
    // <cachedir>/autocomplete/functions/bash/<bin>.bash
    return path.join(this.bashFunctionsDir, `${this.cliBin}.bash`)
  }

  private get fishCompletionFunctionPath(): string {
    // dynamically load path to completions file
    const dir = child_process.execSync('pkg-config --variable completionsdir fish').toString().trimRight()
    return `${dir}/${this.cliBin}.fish`
  }

  private get zshCompletionFunctionPath(): string {
    // <cachedir>/autocomplete/functions/zsh/_<bin>
    return path.join(this.zshFunctionsDir, `_${this.cliBin}`)
  }

  private get bashSetupScript(): string {
    const setup = path.join(this.bashFunctionsDir, `${this.cliBin}.bash`)
    const bin = this.cliBinEnvVar
    /* eslint-disable-next-line no-useless-escape */
    return `${bin}_AC_BASH_COMPFUNC_PATH=${setup} && test -f \$${bin}_AC_BASH_COMPFUNC_PATH && source \$${bin}_AC_BASH_COMPFUNC_PATH;
`
  }

  private get zshSetupScript(): string {
    return `
fpath=(
${this.zshFunctionsDir}
$fpath
);
autoload -Uz compinit;
compinit;\n`
  }

  private get commands(): CommandCompletion[] {
    if (this._commands) return this._commands

    const plugins = this.config.plugins
    const cmds: CommandCompletion[] = []

    plugins.forEach(p => {
      p.commands.forEach(c => {
        try {
          if (c.hidden) return
          const description = sanitizeDescription(c.summary || c.description || '')
          const flags = c.flags
          cmds.push({
            id: c.id,
            description,
            flags,
          })
          c.aliases.forEach(a => {
            cmds.push({
              id: a,
              description,
              flags,
            })
          })
        } catch (error: any) {
          debug(`Error creating zsh flag spec for command ${c.id}`)
          debug(error.message)
          this.writeLogFile(error.message)
        }
      })
    })

    this._commands = cmds

    return this._commands
  }

  private genZshFlagSpecs(Klass: any): string {
    return Object.keys(Klass.flags || {})
    .filter(flag => Klass.flags && !Klass.flags[flag].hidden)
    .map(flag => {
      const f = (Klass.flags && Klass.flags[flag]) || {description: ''}
      const isBoolean = f.type === 'boolean'
      const isOption = f.type === 'option'
      const name = isBoolean ? flag : `${flag}=-`
      const multiple = isOption && f.multiple ? '*' : ''
      const valueCmpl = isBoolean ? '' : ':'
      const completion = `${multiple}--${name}[${sanitizeDescription(f.summary || f.description)}]${valueCmpl}`
      return `"${completion}"`
    })
    .join('\n')
  }

  /* eslint-disable no-useless-escape */
  private get genAllCommandsMetaString(): string {
    return this.commands.map(c => {
      return `\"${c.id.replace(/:/g, '\\:')}:${c.description}\"`
    }).join('\n')
  }
  /* eslint-enable no-useless-escape */

  private get genCaseStatementForFlagsMetaString(): string {
    // command)
    //   _command_flags=(
    //   "--boolean[bool descr]"
    //   "--value=-[value descr]:"
    //   )
    // ;;
    return this.commands.map(c => {
      return `${c.id})
  _command_flags=(
    ${this.genZshFlagSpecs(c)}
  )
;;\n`
    }).join('\n')
  }

  private genCmdPublicFlags(Command: CommandCompletion): string {
    const Flags = Command.flags || {}
    return Object.keys(Flags)
    .filter(flag => !Flags[flag].hidden)
    .map(flag => `--${flag}`)
    .join(' ')
  }

  private get bashCommandsWithFlagsList(): string {
    return this.commands.map(c => {
      const publicFlags = this.genCmdPublicFlags(c).trim()
      return `${c.id} ${publicFlags}`
    }).join('\n')
  }

  private get bashCompletionFunction(): string {
    const cliBin = this.cliBin
    const supportSpaces = this.config.topicSeparator === ' '
    const bashScript = (process.env.OCLIF_AUTOCOMPLETE_TOPIC_SEPARATOR === 'colon' || !supportSpaces) ? bashAutocomplete : bashAutocompleteWithSpaces
    return bashScript.replace(/<CLI_BIN>/g, cliBin).replace(/<BASH_COMMANDS_WITH_FLAGS_LIST>/g, this.bashCommandsWithFlagsList)
  }

  private get fishCompletionFunction(): string {
    const cliBin = this.cliBin
    const completions = []
    completions.push(`
function __fish_${cliBin}_needs_command
  set cmd (commandline -opc)
  if [ (count $cmd) -eq 1 ]
    return 0
  else
    return 1
  end
end

function  __fish_${cliBin}_using_command
  set cmd (commandline -opc)
  if [ (count $cmd) -gt 1 ]
    if [ $argv[1] = $cmd[2] ]
      return 0
    end
  end
  return 1
end`,
    )

    for (const command of this.commands) {
      completions.push(`complete -f -c ${cliBin} -n '__fish_${cliBin}_needs_command' -a ${command.id} -d "${command.description}"`)
      const flags = command.flags || {}
      Object.keys(flags)
      .filter(flag => flags[flag] && !flags[flag].hidden)
      .forEach(flag => {
        const f = flags[flag] || {}
        const shortFlag = f.char ? `-s ${f.char}` : ''
        const description = f.description ? `-d "${f.description}"` : ''
        const options = f.options ? `-r -a "${f.options.join(' ')}"` : ''
        completions.push(`complete -f -c ${cliBin} -n ' __fish_${cliBin}_using_command ${command.id}' -l ${flag} ${shortFlag} ${options} ${description}`)
      })
    }
    return completions.join('\n')
  }

  private get zshCompletionFunction(): string {
    const cliBin = this.cliBin
    const allCommandsMeta = this.genAllCommandsMetaString
    const caseStatementForFlagsMeta = this.genCaseStatementForFlagsMetaString
    return `#compdef ${cliBin}
_${cliBin} () {
  local _command_id=\${words[2]}
  local _cur=\${words[CURRENT]}
  local -a _command_flags=()

  ## public cli commands & flags
  local -a _all_commands=(
${allCommandsMeta}
  )

  _set_flags () {
    case $_command_id in
${caseStatementForFlagsMeta}
    esac
  }
  ## end public cli commands & flags

  _complete_commands () {
    _describe -t all-commands "all commands" _all_commands
  }

  if [ $CURRENT -gt 2 ]; then
    if [[ "$_cur" == -* ]]; then
      _set_flags
    else
      _path_files
    fi
  fi


  _arguments -S '1: :_complete_commands' \\
                $_command_flags
}

_${cliBin}
`
  }
}

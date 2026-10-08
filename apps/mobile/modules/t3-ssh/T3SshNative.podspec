require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3SshNative'
  s.version = package['version']
  s.summary = 'Host-key verified SSH transport for KM Code mobile.'
  s.description = 'Native SSH session and local forwarding bridge used by KM Code mobile.'
  s.homepage = 'https://github.com/kmccleary3301/kmcode'
  s.license = { :type => 'MIT' }
  s.author = 'KM Code contributors'
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks = 'Network'
  s.libraries = 'c++'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  s.dependency 'libssh2-iosx', '1.11.0.1'
end
